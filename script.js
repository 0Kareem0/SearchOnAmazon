const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Initialize stealth plugin
puppeteer.use(StealthPlugin());

// Configuration
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_QUERY = 'laptops';
const DATA_DIR = path.join(__dirname, 'data');

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Helper functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => delay(Math.floor(Math.random() * 2000) + 1000);

(async () => {
  const browser = await puppeteer.launch({
    headless: false, // Set to true for production
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    ignoreHTTPSErrors: true
  });

  const page = await browser.newPage();

  try {
    // Configure browser settings
    await page.setUserAgent(USER_AGENT);
    await page.setJavaScriptEnabled(true);
    await page.setDefaultNavigationTimeout(60000);
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
    });

    // Navigate to Amazon Egypt with retry logic
    let loaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Navigation attempt ${attempt}/3`);
        await page.goto('https://www.amazon.eg', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        loaded = true;
        break;
      } catch (err) {
        console.log(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw err;
        await delay(5000);
      }
    }

    if (!loaded) throw new Error('Failed to load Amazon Egypt after 3 attempts');

    // Check for CAPTCHA
    const captchaDetected = await page.evaluate(() => {
      return document.querySelector('#captchacharacters, form[action*="captcha"]') !== null;
    });

    if (captchaDetected) {
      console.log('CAPTCHA detected. Please solve it manually in the browser...');
      await page.waitForFunction(
        () => !document.querySelector('#captchacharacters, form[action*="captcha"]'),
        { timeout: 120000, polling: 1000 }
      );
      console.log('CAPTCHA solved, continuing...');
    }

    // Search for products
    const searchBoxSelectors = [
      '#twotabsearchtextbox',
      'input[name="field-keywords"]',
      '#nav-search-bar-form input[type="text"]'
    ];

    let searchBoxFound = false;
    for (const selector of searchBoxSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        searchBoxFound = true;
        await page.type(selector, SEARCH_QUERY, { delay: 50 + Math.random() * 100 });
        await randomDelay();
        await page.keyboard.press('Enter');
        break;
      } catch (e) {
        continue;
      }
    }

    if (!searchBoxFound) {
      throw new Error('Could not find search box');
    }

    // Wait for search results
    const resultsSelector = [
      '[data-component-type="s-search-result"]',
      '.s-result-item',
      '.s-main-slot'
    ];

    let resultsFound = false;
    for (const selector of resultsSelector) {
      try {
        await page.waitForSelector(selector, { timeout: 15000 });
        resultsFound = true;
        break;
      } catch (e) {
        continue;
      }
    }

    if (!resultsFound) {
      throw new Error('Could not find search results');
    }

    // Scroll to load more items
    await autoScroll(page);

    // Extract product data with robust selectors
    const products = await page.evaluate(() => {
      const extractPrice = (priceElement) => {
        if (!priceElement) return null;
        const priceText = priceElement.textContent.trim();
        const priceMatch = priceText.match(/([\d,]+\.\d+)/);
        return priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
      };

      const items = Array.from(document.querySelectorAll(
        '[data-component-type="s-search-result"]:not(.AdHolder), ' +
        '.s-result-item:not(.s-ad-slot), ' +
        '.s-main-slot .s-result-item'
      ));

      return items.map(item => {
        // Name extraction with fallbacks
        const nameElement = item.querySelector(
          'h2 a span, ' +
          '.a-size-medium, ' +
          'h2.a-size-mini a, ' +
          '.s-title-instructions-style h2'
        );
        
        // Price extraction with fallbacks
        const priceElement = item.querySelector(
          '.a-price .a-offscreen, ' +
          '.a-price-whole, ' +
          '.a-color-price, ' +
          '.s-price-instructions-style .a-color-base'
        );

        // Image extraction with fallbacks
        const imageElement = item.querySelector(
          '.s-image, ' +
          'img[data-image-latency="s-product-image"], ' +
          '.s-product-image-container img'
        );

        return {
          title: nameElement?.textContent?.trim() || null,
          price: extractPrice(priceElement),
          imageUrl: imageElement?.src || imageElement?.getAttribute('data-src') || null,
          url: item.querySelector('h2 a')?.href || null,
          asin: item.getAttribute('data-asin') || null
        };
      }).filter(product => product.title && product.price); // Filter out invalid items
    });

    // Save data with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(DATA_DIR, `amazon-eg-products-${timestamp}.json`);
    fs.writeFileSync(filename, JSON.stringify(products, null, 2));
    console.log(`Successfully saved ${products.length} products to ${filename}`);

    // Take a screenshot of the results for verification
    await page.screenshot({ path: path.join(DATA_DIR, 'results-screenshot.png'), fullPage: true });

  } catch (error) {
    console.error('Error during scraping:', error);
    // Take screenshot on error
    const errorScreenshotPath = path.join(DATA_DIR, 'error-screenshot.png');
    await page.screenshot({ path: errorScreenshotPath, fullPage: true });
    console.log(`Error screenshot saved to ${errorScreenshotPath}`);
  } finally {
    await browser.close();
  }
})();

// Auto-scroll function to load all products
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}