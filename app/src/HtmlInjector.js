const fs = require('fs');

const path = require('path');

const chokidar = require('chokidar');

const Logger = require('./Logger');

const log = new Logger('HtmlInjector');

class HtmlInjector {
    constructor(filesPath, config) {
        this.filesPath = filesPath; // Array of file paths to cache
        this.cache = {}; // Object to store cached files
        this.config = config; // Configuration containing metadata (OG, title, etc.)
        this.injectData = this.getInjectData(); // Initialize dynamic injection data
        this.watcher = null; // File watcher instance
        this.preloadPages(filesPath); // Preload pages at startup
        this.watchFiles(filesPath); // Watch files for changes
        log.info('filesPath cached', this.filesPath);
    }

    // Function to get dynamic data for injection (e.g., OG data, title, etc.)
    getInjectData() {
        return {
            OG_TYPE: this.config?.og?.type || 'app-webrtc',
            OG_SITE_NAME: this.config?.og?.siteName || 'MiroTalk SFU',
            OG_TITLE: this.config?.og?.title || 'Click the link to make a call.',
            OG_DESCRIPTION:
                this.config?.og?.description ||
                'MiroTalk SFU calling provides real-time video calls, messaging and screen sharing.',
            OG_IMAGE: this.config?.og?.image || 'https://sfu.mirotalk.com/images/mirotalksfu.png',
            OG_URL: this.config?.og?.url || 'https://sfu.mirotalk.com',
            // Add more data here as needed with fallbacks
        };
    }

    // Function to load a file into the cache
    loadFileToCache(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            this.cache[filePath] = content; // Store the content in cache
        } catch (err) {
            log.error(`Error reading file: ${filePath}`, err);
        }
    }

    // Function to preload pages into the cache
    preloadPages(filePaths) {
        filePaths.forEach((filePath) => this.loadFileToCache(filePath));
    }

    // Function to watch files for changes using chokidar
    watchFiles(filePaths) {
        if (this.watcher) {
            this.watcher.close(); // Close existing watcher if any
        }

        this.watcher = chokidar.watch(filePaths, {
            persistent: true,
            ignoreInitial: true, // Ignore initial 'add' events
        });

        this.watcher
            .on('change', (filePath) => {
                log.debug(`File changed: ${filePath}`);
                this.loadFileToCache(filePath);
                log.debug(`Reloaded file ${filePath} into cache`);
            })
            .on('error', (error) => {
                log.error(`Watcher error: ${error.message}`);
            });
    }

    // Montemeet: к нашим файлам дописываем отметку времени.
    //
    // Подключены они без версии, а браузер вправе держать прежнюю копию сколько
    // угодно: на телефоне Ивана правка так и не «приехала», хотя на сервере
    // лежала новая (2026-08-19). Отметка считается по самому свежему из наших
    // файлов, поэтому достаточно выложить код — страница сама попросит новые.
    // Значение пересчитывается не чаще раза в десять секунд: страницу открывают
    // редко, а лишний обход каталога ни к чему.
    montemeetAssetVersion() {
        const now = Date.now();
        if (this._mmAssets && now - this._mmAssets.at < 10000) return this._mmAssets.value;
        let newest = 0;
        for (const [dir, re] of [
            ['js', /^Montemeet[\w.]*\.js$/],
            ['css', /^Montemeet[\w.]*\.css$/],
        ]) {
            const full = path.join(__dirname, '../../public', dir);
            try {
                for (const name of fs.readdirSync(full)) {
                    if (!re.test(name)) continue;
                    const { mtimeMs } = fs.statSync(path.join(full, name));
                    if (mtimeMs > newest) newest = mtimeMs;
                }
            } catch (err) {
                /* каталога нет — обойдёмся без отметки */
            }
        }
        this._mmAssets = { at: now, value: Math.floor(newest) };
        return this._mmAssets.value;
    }

    stampMontemeetAssets(html) {
        const version = this.montemeetAssetVersion();
        if (!version) return html;
        return html.replace(/(\.\.\/(?:js|css)\/Montemeet[\w.]*\.(?:js|css))"/g, `$1?v=${version}"`);
    }

    // Function to inject dynamic data (e.g., OG, TITLE, etc.) into a given file
    injectHtml(filePath, res) {
        // Check if HTML injection is enabled in the config
        if (!this.config?.htmlInjection) {
            return res.send(this.stampMontemeetAssets(this.cache[filePath] || ''));
        }

        if (!this.cache[filePath]) {
            log.error(`File not cached: ${filePath}`);
            if (!res.headersSent) {
                return res.status(500).send('Server Error');
            }
            return;
        }

        try {
            // Replace placeholders with dynamic data (OG, TITLE, etc.)
            const modifiedHTML = this.stampMontemeetAssets(
                this.cache[filePath].replace(/{{(OG_[A-Z_]+)}}/g, (_, key) => this.injectData[key] || '')
            );

            if (!res.headersSent) {
                res.send(modifiedHTML);
            }
        } catch (error) {
            log.error('Error injecting HTML data:', error);
            if (!res.headersSent) {
                res.status(500).send('Server Error');
            }
        }
    }

    // Cleanup watcher when the instance is no longer needed
    cleanup() {
        if (this.watcher) {
            this.watcher.close();
        }
    }
}

module.exports = HtmlInjector;
