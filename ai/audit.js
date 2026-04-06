const puppeteer = require('puppeteer-core');

/**
 * Headless Profile Auditor
 * Navigates to a social profile link and extracts KPIs for the database.
 */
async function auditProfile(url) {
    console.log(`🔍 AUDIT: Starting deep scan for ${url}...`);
    
    let browser;
    try {
        // Find local chrome installation - Dynamic import to support ESM on Linux
        const chromeLauncher = await import('chrome-launcher');
        const chromePath = chromeLauncher.Launcher.getInstallations()[0];
        if (!chromePath) throw new Error("Google Chrome not found on this system.");

        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-accelerated-2d-canvas', 
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate with strict timeout
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });

        // Basic Info Extraction (Generic - AI will refine)
        const profileData = await page.evaluate(() => {
            const bio = document.querySelector('header section div:nth-child(3) span')?.innerText || "";
            const followersText = [...document.querySelectorAll('header li')].find(li => li.innerText.includes('followers'))?.innerText || "0";
            
            return {
                bio,
                followersText,
                pageTitle: document.title,
                url: window.location.href
            };
        });

        console.log(`✅ AUDIT: Basic data captured for ${profileData.pageTitle}`);
        return {
            success: true,
            data: {
                ...profileData,
                auditedAt: new Date().toISOString()
            }
        };

    } catch (err) {
        console.error("❌ AUDIT ERROR:", err.message);
        return { success: false, error: err.message };
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { auditProfile };
