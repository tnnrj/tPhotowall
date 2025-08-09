const CONSTANTS = {
    AUTO_HIDE_DELAY: 3000,
    HEIC_EXTENSIONS: ['.heic', '.heif'],
    JPEG_QUALITY: 0.8,
    MAX_RETRY_ATTEMPTS: 3,
    CONVERSION_TIMEOUT: 30000,
    CACHE_SIZE_LIMIT: 200
};

class PhotoCache {
    constructor() {
        this.cache = new Map();
        this.heicSupportCache = null;
        this.loadingPromises = new Map();
    }

    async initialize() {
        try {
            this.heicSupportCache = await window.electronAPI.isHeicSupported();
            console.log('PhotoCache: HEIC support', this.heicSupportCache ? 'enabled' : 'disabled');
        } catch (error) {
            console.error('PhotoCache: Failed to check HEIC support:', error);
            this.heicSupportCache = false;
        }
    }

    isHeicFile(filePath) {
        const extension = '.' + filePath.toLowerCase().split('.').pop();
        return CONSTANTS.HEIC_EXTENSIONS.includes(extension);
    }

    async refresh(newPhotoPaths) {
        const currentPaths = new Set(this.cache.keys());
        const newPaths = new Set(newPhotoPaths);
        
        for (const path of currentPaths) {
            if (!newPaths.has(path)) {
                const cached = this.cache.get(path);
                if (cached && cached.url.startsWith('blob:')) {
                    console.log('PhotoCache: Revoking blob URL for deleted photo:', path, cached.url);
                    URL.revokeObjectURL(cached.url);
                }
                this.cache.delete(path);
                console.log('PhotoCache: Removed from cache:', path);
            }
        }

        const newFiles = newPhotoPaths.filter(path => !currentPaths.has(path));
        if (newFiles.length > 0) {
            console.log(`PhotoCache: Found ${newFiles.length} new photos to cache`);
            // load in background without blocking
            this.preloadPhotos(newFiles.slice(0, 10));
        }

        this.cleanupCache();
    }

    async preloadPhotos(photoPaths) {
        for (const path of photoPaths) {
            this.getPhoto(path).catch(error => {
                console.warn('PhotoCache: Background preload failed for', path, error);
            });
        }
    }

    async getPhoto(photoPath) {
        if (this.cache.has(photoPath)) {
            const cached = this.cache.get(photoPath);
            cached.lastAccessed = Date.now();
            console.log('PhotoCache: Retrieved from cache:', photoPath, 'URL:', cached.url);
            return cached.url;
        }

        console.log('PhotoCache: Not in cache, loading:', photoPath);

        if (this.loadingPromises.has(photoPath)) {
            console.log('PhotoCache: Already loading, waiting for existing promise:', photoPath);
            return this.loadingPromises.get(photoPath);
        }

        const loadPromise = this.loadPhoto(photoPath);
        this.loadingPromises.set(photoPath, loadPromise);

        try {
            const url = await loadPromise;
            console.log('PhotoCache: Finished loading:', photoPath, 'URL:', url);
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
                if (!this.heicSupportCache) {
                    throw new Error('HEIC support not available');
                }
                url = await this.loadHEICImage(photoPath);
            } else {
                url = await this.loadRegularImage(photoPath);
            }

            this.cache.set(photoPath, {
                url,
                isHeic,
                lastAccessed: Date.now()
            });

            console.log('PhotoCache: Cached', photoPath);
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

    cleanupCache() {
        if (this.cache.size <= CONSTANTS.CACHE_SIZE_LIMIT) {
            return;
        }

        // Sort by last accessed time and remove oldest
        const entries = Array.from(this.cache.entries())
            .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

        const toRemove = entries.slice(0, entries.length - CONSTANTS.CACHE_SIZE_LIMIT);
        
        for (const [path, cached] of toRemove) {
            if (cached.url.startsWith('blob:')) {
                console.log('PhotoCache: Cleanup - revoking old blob URL:', path, cached.url);
                URL.revokeObjectURL(cached.url);
            }
            this.cache.delete(path);
        }

        console.log(`PhotoCache: Cleaned up ${toRemove.length} old entries`);
    }

    clear() {
        console.log('PhotoCache: Clearing entire cache');
        // Clean up all blob URLs
        for (const [path, cached] of this.cache.entries()) {
            if (cached.url.startsWith('blob:')) {
                console.log('PhotoCache: Clear - revoking blob URL:', path, cached.url);
                URL.revokeObjectURL(cached.url);
            }
        }
        this.cache.clear();
        this.loadingPromises.clear();
        console.log('PhotoCache: Cache cleared');
    }

    getCacheStats() {
        const total = this.cache.size;
        const heicCount = Array.from(this.cache.values()).filter(cached => cached.isHeic).length;
        return { total, heicCount, loading: this.loadingPromises.size };
    }
}

class PhotoSlideshow {
    constructor() {
        this.photos = [];
        this.currentIndex = 0;
        this.isPlaying = false;
        this.slideInterval = null;
        this.currentFolder = '';
        this.isRandomOrder = false;
        this.playedIndices = new Set();
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
                    this.photos = photos;
                    this.currentIndex = 0;
                    this.playedIndices.clear();
                    this.playedIndices.add(0);
                    
                    await this.photoCache.refresh(this.photos);
                    
                    await this.updatePhotoDisplay();
                    this.enableControls();
                    this.updatePhotoInfo();
                    
                    console.log(`Auto-loaded ${this.photos.length} photos from startup folder`);
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
        this.prevBtn = document.getElementById('prevBtn');
        this.nextBtn = document.getElementById('nextBtn');
        this.intervalSelect = document.getElementById('intervalSelect');
        this.randomOrderCheckbox = document.getElementById('randomOrder');
        
        this.photoContainer = document.getElementById('photoContainer');
        this.currentPhoto = document.getElementById('currentPhoto');
        this.welcomeMessage = document.getElementById('welcomeMessage');
        this.loadingMessage = document.getElementById('loadingMessage');
        
        this.currentPhotoIndex = document.getElementById('currentPhotoIndex');
        this.totalPhotos = document.getElementById('totalPhotos');
    }

    bindEvents() {
        this.selectFolderBtn.addEventListener('click', () => this.selectFolder());
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.prevBtn.addEventListener('click', () => this.previousPhoto());
        this.nextBtn.addEventListener('click', () => this.nextPhoto());
        
        this.intervalSelect.addEventListener('change', () => this.updateInterval());
        this.randomOrderCheckbox.addEventListener('change', (e) => {
            this.isRandomOrder = e.target.checked;
            if (this.isRandomOrder) {
                this.playedIndices.clear();
                this.playedIndices.add(this.currentIndex);
            }
        });
        
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
            
            if (result && result.photos.length > 0) {
                this.currentFolder = result.folder;
                this.photos = result.photos;
                this.currentIndex = 0;
                this.playedIndices.clear();
                this.playedIndices.add(0);
                
                await this.photoCache.refresh(this.photos);
                
                await this.updatePhotoDisplay();
                this.enableControls();
                this.updatePhotoInfo();
                
                console.log(`Loaded ${this.photos.length} photos from ${this.currentFolder}`);
                console.log('Cache stats:', this.photoCache.getCacheStats());
            } else if (result && result.photos.length === 0) {
                alert('No photos found in the selected folder.');
            }
        } catch (error) {
            console.error('Error selecting folder:', error);
            alert('Error selecting folder. Please try again.');
        } finally {
            this.showLoading(false);
        }
    }

    async updatePhotoList(newPhotos) {
        const wasEmpty = this.photos.length === 0;
        this.photos = newPhotos;
        
        if (this.photos.length === 0) {
            this.disableControls();
            this.showWelcomeMessage();
            this.photoCache.clear();
            return;
        }
        
        await this.photoCache.refresh(this.photos);
        
        if (wasEmpty) {
            this.currentIndex = 0;
            this.playedIndices.clear();
            this.playedIndices.add(0);
            await this.updatePhotoDisplay();
            this.enableControls();
        } else {
            if (this.currentIndex >= this.photos.length) {
                this.currentIndex = this.photos.length - 1;
            }
        }
        
        this.updatePhotoInfo();
        console.log('Cache stats after update:', this.photoCache.getCacheStats());
    }

    async updatePhotoDisplay() {
        if (this.photos.length === 0) {
            this.showWelcomeMessage();
            return;
        }

        const photoPath = this.photos[this.currentIndex];
        console.log('Updating photo display for:', photoPath);
        
        try {
            const imageUrl = await this.photoCache.getPhoto(photoPath);
            console.log('Got image URL from cache:', imageUrl);
            this.displayCachedPhoto(imageUrl);
        } catch (error) {
            console.error('Failed to load photo:', photoPath, error);
            this.showErrorMessage('Failed to load photo. Skipping to next photo.');
            this.nextPhoto();
        }
    }

    displayCachedPhoto(imageUrl) {
        console.log('Displaying cached photo:', imageUrl);
        
        // Use a new Image element to test if the URL is valid before setting it
        const testImg = new Image();
        testImg.onload = () => {
            console.log('Cached image loaded successfully');
            this.currentPhoto.src = imageUrl;
            this.currentPhoto.style.display = 'block';
            this.welcomeMessage.style.display = 'none';
            this.currentPhoto.classList.remove('fade-out');
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
        if (this.photos.length === 0) return;
        
        if (this.isRandomOrder) {
            this.nextRandomPhoto();
        } else {
            this.currentIndex = (this.currentIndex + 1) % this.photos.length;
        }
        
        await this.updatePhotoDisplay();
        this.updatePhotoInfo();
    }

    async previousPhoto() {
        if (this.photos.length === 0) return;
        
        if (this.isRandomOrder) {
            this.previousRandomPhoto();
        } else {
            this.currentIndex = this.currentIndex > 0 ? this.currentIndex - 1 : this.photos.length - 1;
        }
        
        await this.updatePhotoDisplay();
        this.updatePhotoInfo();
    }

    nextRandomPhoto() {
        if (this.playedIndices.size >= this.photos.length) {
            this.playedIndices.clear();
        }
        
        let nextIndex;
        do {
            nextIndex = Math.floor(Math.random() * this.photos.length);
        } while (this.playedIndices.has(nextIndex) && this.playedIndices.size < this.photos.length);
        
        this.currentIndex = nextIndex;
        this.playedIndices.add(nextIndex);
    }

    previousRandomPhoto() {
        // Previous doesn't make sense in random mode
        this.nextRandomPhoto();
    }

    togglePlayPause() {
        if (this.isPlaying) {
            this.pauseSlideshow();
        } else {
            this.startSlideshow();
        }
    }

    startSlideshow() {
        if (this.photos.length === 0) return;
        
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
        this.prevBtn.disabled = false;
        this.nextBtn.disabled = false;
    }

    disableControls() {
        this.playPauseBtn.disabled = true;
        this.prevBtn.disabled = true;
        this.nextBtn.disabled = true;
        this.pauseSlideshow();
    }

    updatePhotoInfo() {
        this.currentPhotoIndex.textContent = this.photos.length > 0 ? this.currentIndex + 1 : 0;
        this.totalPhotos.textContent = this.photos.length;
    }

    showWelcomeMessage() {
        this.currentPhoto.style.display = 'none';
        this.welcomeMessage.style.display = 'block';
    }

    showLoading(show) {
        this.loadingMessage.style.display = show ? 'block' : 'none';
        if (show) {
            this.welcomeMessage.style.display = 'none';
            this.currentPhoto.style.display = 'none';
        }
    }

    handleKeyboard(event) {
        switch (event.code) {
            case 'Space':
                event.preventDefault();
                this.togglePlayPause();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this.previousPhoto();
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
