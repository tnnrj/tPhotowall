const CONSTANTS = {
    AUTO_HIDE_DELAY: 3000,
    HEIC_EXTENSIONS: ['.heic', '.heif'],
    JPEG_QUALITY: 0.8,
    MAX_RETRY_ATTEMPTS: 3,
    CONVERSION_TIMEOUT: 30000,
    CACHE_SIZE_LIMIT: 200,
    VISIBLE_PHOTOS: 6
};

class PhotoCache {
    constructor() {
        this.queue = [];
        this.heicSupport = null;
        this.loadingPromises = new Map();
    }

    async initialize() {
        try {
            this.heicSupport = await window.electronAPI.isHeicSupported();
            console.log('PhotoCache: HEIC support', this.heicSupport ? 'enabled' : 'disabled');
        } catch (error) {
            console.error('PhotoCache: Failed to check HEIC support:', error);
            this.heicSupport = false;
        }
    }

    getNextPhoto() {
        const nextPhoto = this.queue.shift();
        if (nextPhoto) {
            this.queue.push(nextPhoto);
        }
        return nextPhoto?.url;
    }

    isHeicFile(filePath) {
        const extension = '.' + filePath.toLowerCase().split('.').pop();
        return CONSTANTS.HEIC_EXTENSIONS.includes(extension);
    }

    async refresh(newPhotoPaths) {
        const newQ = [];
        const newPaths = new Set(newPhotoPaths);
        const currentPaths = new Set(this.queue.map(file => file.path));

        for (const curFile of this.queue) {
            if (!newPaths.has(curFile.path)) {
                if (curFile.url.startsWith('blob:')) {
                    console.log('PhotoCache: Revoking blob URL for deleted photo:', path, cached.url);
                    URL.revokeObjectURL(cached.url);
                }
                console.log('PhotoCache: Removed from cache:', path);
            } else {
                newQ.push(curFile);
            }
        }

        const newFiles = newPhotoPaths.filter(path => !currentPaths.has(path));
        if (newFiles.length > 0) {
            console.log(`PhotoCache: Found ${newFiles.length} new photos to cache`);
            // load in background without blocking
            this.preloadPhotos(newFiles);
        }
    }

    async preloadPhotos(photoPaths) {
        for (const path of photoPaths) {
            this.loadPhotoToFrontOfQueue(path).catch(error => {
                console.warn('PhotoCache: Background preload failed for', path, error);
            });
        }
    }

    async loadPhotoToFrontOfQueue(photoPath) {
        if (this.loadingPromises.has(photoPath)) {
            console.log('PhotoCache: Already loading, waiting for existing promise:', photoPath);
            return this.loadingPromises.get(photoPath);
        }

        const loadPromise = this.loadPhoto(photoPath);
        this.loadingPromises.set(photoPath, loadPromise);

        try {
            const url = await loadPromise;
            console.log('PhotoCache: Finished loading:', photoPath, 'URL:', url);
            this.queue.unshift({ path: photoPath, url: url });
            return url;
        } finally {
            this.loadingPromises.delete(photoPath);
        }
    }

    async loadPhoto(photoPath) {
        try {
            let url;
            const isHeic = this.isHeicFile(photoPath);

            if (isHeic) {
                if (!this.heicSupport) {
                    throw new Error('HEIC support not available');
                }
                url = await this.loadHEICImage(photoPath);
            } else {
                url = await this.loadRegularImage(photoPath);
            }

            console.log('PhotoCache: Loaded', photoPath);
            return url;
        } catch (error) {
            console.error('PhotoCache: Failed to load', photoPath, error);
            throw error;
        }
    }

    async loadRegularImage(photoPath) {
        return new Promise((resolve, reject) => {
            try {
                // Properly encode the file path for URL usage
                const normalizedPath = photoPath.replace(/\\/g, '/');
                const encodedPath = normalizedPath.split('/').map(encodeURIComponent).join('/');
                const fileUrl = `file:///${encodedPath}`;

                console.log('PhotoCache: Loading regular image:', photoPath);
                console.log('PhotoCache: Normalized path:', normalizedPath);
                console.log('PhotoCache: Encoded file URL:', fileUrl);

                const img = new Image();
                img.onload = () => {
                    console.log('PhotoCache: Regular image loaded successfully');
                    resolve(fileUrl);
                };
                img.onerror = (error) => {
                    console.error('PhotoCache: Failed to load regular image:', photoPath, error);
                    reject(new Error(`Failed to load image: ${photoPath}`));
                };
                img.src = fileUrl;
            } catch (error) {
                console.error('PhotoCache: Error preparing regular image URL:', photoPath, error);
                reject(error);
            }
        });
    }

    async loadHEICImage(photoPath) {
        try {
            // Properly encode the file path for URL usage
            const normalizedPath = photoPath.replace(/\\/g, '/');
            const encodedPath = normalizedPath.split('/').map(encodeURIComponent).join('/');
            const fileUrl = `file:///${encodedPath}`;

            console.log('PhotoCache: Loading HEIC file:', photoPath);
            console.log('PhotoCache: Normalized path:', normalizedPath);
            console.log('PhotoCache: Encoded file URL:', fileUrl);

            const response = await fetch(fileUrl);

            if (!response.ok) {
                throw new Error(`Failed to fetch HEIC file: ${response.status} ${response.statusText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            console.log('PhotoCache: HEIC file size:', arrayBuffer.byteLength, 'bytes');

            if (arrayBuffer.byteLength === 0) {
                throw new Error('HEIC file is empty');
            }

            const uint8Array = new Uint8Array(arrayBuffer);

            const result = await window.electronAPI.convertHeic(uint8Array);

            if (!result) {
                throw new Error('No result from HEIC conversion');
            }

            const { width, height, imageData } = result;
            console.log('PhotoCache: HEIC conversion successful, dimensions:', width, 'x', height);

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const context = canvas.getContext('2d');
            const canvasImageData = context.createImageData(width, height);

            const uint8ClampedArray = new Uint8ClampedArray(imageData);
            canvasImageData.data.set(uint8ClampedArray);

            context.putImageData(canvasImageData, 0, 0);

            const blob = await new Promise(resolve => {
                canvas.toBlob(resolve, 'image/jpeg', CONSTANTS.JPEG_QUALITY);
            });

            const blobUrl = URL.createObjectURL(blob);
            console.log('PhotoCache: Created blob URL for HEIC:', blobUrl);

            return blobUrl;
        } catch (error) {
            console.error('PhotoCache: Error converting HEIC image:', photoPath, error);
            throw error;
        }
    }

    clear() {
        console.log('PhotoCache: Clearing entire cache');
        // Clean up all blob URLs
        for (const { path, url } of this.queue) {
            if (url.startsWith('blob:')) {
                console.log('PhotoCache: Clear - revoking blob URL:', path, url);
                URL.revokeObjectURL(url);
            }
        }
        this.queue = [];
        this.loadingPromises.clear();
        console.log('PhotoCache: Cache cleared');
    }

    getCacheStats() {
        const total = this.queue.length;
        const heicCount = this.queue.filter(cached => cached.isHeic).length;
        return { total, heicCount, loading: this.loadingPromises.size };
    }
}

class PhotoSlideshow {
    constructor() {
        this.currentIndex = 0;
        this.isPlaying = false;
        this.slideInterval = null;
        this.currentFolder = '';
        this.photoCache = new PhotoCache();

        this.initializeElements();
        this.bindEvents();
        this.setupAutoHide();
        this.initializeCache();
        this.loadStartupFolder();
    }

    async initializeCache() {
        try {
            await this.photoCache.initialize();
        } catch (error) {
            console.error('Failed to initialize photo cache:', error);
        }
    }

    async loadStartupFolder() {
        try {
            const startupFolder = await window.electronAPI.getStartupFolder();
            if (startupFolder) {
                console.log('Loading startup folder:', startupFolder);
                this.showLoading(true);

                const photos = await window.electronAPI.getPhotos(startupFolder);
                if (photos && photos.length > 0) {
                    this.currentFolder = startupFolder;
                    this.currentIndex = 0;

                    await this.updatePhotoList(photos);
                    for (let i = 0; i < CONSTANTS.VISIBLE_PHOTOS; i++) {
                        await this.nextPhoto();
                    }

                    console.log(`Auto-loaded ${photos.length} photos from startup folder`);
                    console.log('Cache stats:', this.photoCache.getCacheStats());
                } else {
                    console.warn('Startup folder exists but contains no photos:', startupFolder);
                }

                this.showLoading(false);
            }
        } catch (error) {
            console.error('Failed to load startup folder:', error);
            this.showLoading(false);
        }
    }

    initializeElements() {
        this.selectFolderBtn = document.getElementById('selectFolderBtn');
        this.playPauseBtn = document.getElementById('playPauseBtn');
        this.nextBtn = document.getElementById('nextBtn');
        this.intervalSelect = document.getElementById('intervalSelect');

        this.photoContainer = document.getElementById('photoContainer');
        this.photoGrid = document.getElementById('photoGrid');
        this.welcomeMessage = document.getElementById('welcomeMessage');
        this.loadingMessage = document.getElementById('loadingMessage');
        this.imgs = [
            document.getElementById('photo1'),
            document.getElementById('photo2'),
            document.getElementById('photo3'),
            document.getElementById('photo4'),
            document.getElementById('photo5'),
            document.getElementById('photo6'),
        ];
    }

    bindEvents() {
        this.selectFolderBtn.addEventListener('click', () => this.selectFolder());
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.nextBtn.addEventListener('click', () => this.nextPhoto());

        this.intervalSelect.addEventListener('change', () => this.updateInterval());

        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        window.electronAPI.onPhotosUpdated(async (event, photos) => {
            console.log('Photos updated:', photos.length);
            await this.updatePhotoList(photos);
        });
    }

    setupAutoHide() {
        let hideTimeout;

        const showControls = () => {
            document.body.classList.remove('auto-hide');
            clearTimeout(hideTimeout);
            hideTimeout = setTimeout(() => {
                if (this.isPlaying) {
                    document.body.classList.add('auto-hide');
                }
            }, CONSTANTS.AUTO_HIDE_DELAY);
        };

        document.addEventListener('mousemove', showControls);
        document.addEventListener('keydown', showControls);
    }

    async selectFolder() {
        try {
            this.showLoading(true);
            const result = await window.electronAPI.selectFolder();
            this.enableControls();
            await this.updatePhotoList(result.photos);
            for (let i = 0; i < CONSTANTS.VISIBLE_PHOTOS; i++) {
                await this.nextPhoto();
            }
        } catch (error) {
            console.error('Error selecting folder:', error);
            alert('Error selecting folder. Please try again.');
        } finally {
            this.showLoading(false);
        }
    }

    async updatePhotoList(newPhotos) {
        if (newPhotos.length === 0) {
            this.disableControls();
            this.showWelcomeMessage();
            this.photoCache.clear();
            return;
        }

        await this.photoCache.refresh(newPhotos);
        this.photoGrid.style.display = 'flex';
        console.log('Cache stats after update:', this.photoCache.getCacheStats());
    }

    displayCachedPhoto(imageUrl) {
        console.log('Displaying cached photo:', imageUrl);

        // Use a new Image element to test if the URL is valid before setting it
        const testImg = new Image();
        testImg.onload = () => {
            console.log('Cached image loaded successfully');
            this.imgs[this.currentIndex].src = imageUrl;
            this.imgs[this.currentIndex].style.display = 'block';
            this.welcomeMessage.style.display = 'none';
            this.imgs[this.currentIndex].classList.remove('fade-out');
            this.currentIndex = (this.currentIndex + 1) % CONSTANTS.VISIBLE_PHOTOS;
        };

        testImg.onerror = (error) => {
            console.error('Failed to load cached image:', imageUrl, error);
            this.showErrorMessage('Failed to load cached image. Skipping to next photo.');
            this.nextPhoto();
        };

        testImg.src = imageUrl;
    }

    showErrorMessage(message) {
        console.error(message);
    }

    async nextPhoto() {
        const nextPhotoUrl = this.photoCache.getNextPhoto();
        console.log('Updating photo display for:', this.currentIndex, nextPhotoUrl);

        try {
            this.displayCachedPhoto(nextPhotoUrl);
        } catch (error) {
            console.error('Failed to display photo:', nextPhotoUrl, error);
            this.showErrorMessage('Failed to load photo. Skipping to next photo.');
            this.nextPhoto();
        }
    }

    togglePlayPause() {
        if (this.isPlaying) {
            this.pauseSlideshow();
        } else {
            this.startSlideshow();
        }
    }

    startSlideshow() {
        this.isPlaying = true;
        this.playPauseBtn.textContent = 'Pause';
        this.playPauseBtn.classList.add('playing');

        const interval = parseInt(this.intervalSelect.value);
        this.slideInterval = setInterval(async () => {
            await this.nextPhoto();
        }, interval);

        setTimeout(() => {
            if (this.isPlaying) {
                document.body.classList.add('auto-hide');
            }
        }, 3000);
    }

    pauseSlideshow() {
        this.isPlaying = false;
        this.playPauseBtn.textContent = 'Play';
        this.playPauseBtn.classList.remove('playing');

        if (this.slideInterval) {
            clearInterval(this.slideInterval);
            this.slideInterval = null;
        }

        document.body.classList.remove('auto-hide');
    }

    updateInterval() {
        if (this.isPlaying) {
            this.pauseSlideshow();
            this.startSlideshow();
        }
    }

    enableControls() {
        this.playPauseBtn.disabled = false;
        this.nextBtn.disabled = false;
    }

    disableControls() {
        this.playPauseBtn.disabled = true;
        this.nextBtn.disabled = true;
        this.pauseSlideshow();
    }

    showWelcomeMessage() {
        this.photoGrid.style.display = 'none';
        this.welcomeMessage.style.display = 'block';
    }

    showLoading(show) {
        this.loadingMessage.style.display = show ? 'block' : 'none';
        if (show) {
            this.welcomeMessage.style.display = 'none';
            this.photoGrid.style.display = 'none';
        }
    }

    handleKeyboard(event) {
        switch (event.code) {
            case 'Space':
                event.preventDefault();
                this.togglePlayPause();
                break;
            case 'ArrowRight':
                event.preventDefault();
                this.nextPhoto();
                break;
            case 'KeyF':
                if (event.ctrlKey) {
                    event.preventDefault();
                    this.selectFolder();
                }
                break;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new PhotoSlideshow();
});
