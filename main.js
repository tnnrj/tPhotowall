const { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

const WINDOW_CONFIG = {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600
};

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif'];

let mainWindow;
let folderWatcher;
let currentPhotoFolder = '';
let libheif = null;
let isHeicSupported = false;
let config = {};
let powerSaveBlockerId = null;

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
            config = JSON.parse(configData);
            console.log('Config loaded:', config);
        } else {
            console.log('No config file found, using defaults');
        }
    } catch (error) {
        console.error('Failed to load config:', error);
    }
}

function initializeHeicSupport() {
    try {
        libheif = require('libheif-js');
        isHeicSupported = true;
        console.log('libheif-js loaded successfully');
    } catch (error) {
        console.error('Failed to load libheif-js:', error);
        isHeicSupported = false;
    }
}

loadConfig();
initializeHeicSupport();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: WINDOW_CONFIG.width,
        height: WINDOW_CONFIG.height,
        minWidth: WINDOW_CONFIG.minWidth,
        minHeight: WINDOW_CONFIG.minHeight,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png'),
        show: false // Prevent visual flash
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
}

function getImageFiles(directory) {
    try {
        if (!fs.existsSync(directory)) {
            return [];
        }

        const files = fs.readdirSync(directory);
        return files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return IMAGE_EXTENSIONS.includes(ext);
            })
            .map(file => path.join(directory, file))
            .sort();
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
}

function watchFolder(folderPath) {
    if (folderWatcher) {
        folderWatcher.close();
    }

    folderWatcher = chokidar.watch(folderPath, {
        ignored: /(^|[\/\\])\../, // Ignore dotfiles
        persistent: true
    });

    folderWatcher
        .on('add', () => {
            const photos = getImageFiles(folderPath);
            mainWindow.webContents.send('photos-updated', photos);
        })
        .on('unlink', () => {
            const photos = getImageFiles(folderPath);
            mainWindow.webContents.send('photos-updated', photos);
        });
}

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Photo Folder'
    });

    if (!result.canceled && result.filePaths.length > 0) {
        currentPhotoFolder = result.filePaths[0];
        const photos = getImageFiles(currentPhotoFolder);
        
        watchFolder(currentPhotoFolder);
        
        return {
            folder: currentPhotoFolder,
            photos: photos
        };
    }
    
    return null;
});

ipcMain.handle('get-photos', async (event, folderPath) => {
    return getImageFiles(folderPath);
});

ipcMain.handle('convert-heic', async (event, uint8Array) => {
    if (!isHeicSupported || !libheif) {
        throw new Error('HEIC support is not available');
    }
    
    try {
        const decoder = new libheif.HeifDecoder();
        const data = decoder.decode(uint8Array);
        
        if (!data || data.length === 0) {
            throw new Error('No images found in HEIC file');
        }
        
        const image = data[0];
        const width = image.get_width();
        const height = image.get_height();
        
        if (width <= 0 || height <= 0) {
            throw new Error('Invalid image dimensions');
        }
        
        const imageData = new Uint8ClampedArray(width * height * 4);
        
        // Use promise to handle async callback and add timeout for safety
        await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('HEIC conversion timeout'));
            }, 30000);
            
            image.display({ data: imageData, width, height }, (displayData) => {
                clearTimeout(timeoutId);
                if (!displayData) {
                    return reject(new Error('HEIF processing error'));
                }
                resolve();
            });
        });
        
        // Use Buffer for efficient IPC transfer
        return {
            width,
            height,
            imageData: Buffer.from(imageData.buffer)
        };
    } catch (error) {
        console.error('Error converting HEIC in main process:', error);
        throw new Error(`HEIC conversion failed: ${error.message}`);
    }
});

ipcMain.handle('is-heic-supported', async () => {
    return isHeicSupported;
});

ipcMain.handle('get-startup-folder', async () => {
    if (config && config.startupFolder && fs.existsSync(config.startupFolder)) {
        watchFolder(config.startupFolder);
        return config.startupFolder;
    }
    return undefined;
});

ipcMain.handle('start-power-save-blocking', async () => {
    startPowerSaveBlocking();
    return { success: true, message: 'Power save blocking started' };
});

ipcMain.handle('stop-power-save-blocking', async () => {
    stopPowerSaveBlocking();
    return { success: true, message: 'Power save blocking stopped' };
});

function startPowerSaveBlocking() {
    if (powerSaveBlockerId === null) {
        try {
            // Prevent the system from entering lower-power mode (sleep)
            powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
            console.log('Power save blocking started, ID:', powerSaveBlockerId);
            
            if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                console.log('Power save blocking is active - system will not sleep');
            } else {
                console.warn('Failed to start power save blocking');
                powerSaveBlockerId = null;
            }
        } catch (error) {
            console.error('Error starting power save blocking:', error);
            powerSaveBlockerId = null;
        }
    } else {
        console.log('Power save blocking already active, ID:', powerSaveBlockerId);
    }
}

function stopPowerSaveBlocking() {
    if (powerSaveBlockerId !== null) {
        try {
            powerSaveBlocker.stop(powerSaveBlockerId);
            console.log('Power save blocking stopped, ID:', powerSaveBlockerId);
            powerSaveBlockerId = null;
        } catch (error) {
            console.error('Error stopping power save blocking:', error);
        }
    } else {
        console.log('Power save blocking was not active');
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

function cleanup() {
    if (folderWatcher) {
        folderWatcher.close();
        folderWatcher = null;
    }
    currentPhotoFolder = '';
    stopPowerSaveBlocking();
}

app.on('window-all-closed', () => {
    cleanup();
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    cleanup();
});

// Handle termination signals gracefully
process.on('SIGINT', () => {
    cleanup();
    app.quit();
});

process.on('SIGTERM', () => {
    cleanup();
    app.quit();
});
