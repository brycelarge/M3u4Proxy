import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Inject admin token into localStorage before navigation using correct key
  await context.addInitScript(() => {
    localStorage.setItem('admin_token', 'f6ca41c97aee0967e5c02327e83bc95e25522af0273264c63bd34902400d09af');
  });

  const results = {};

  // Scenario 5: Tab switching
  try {
    await page.goto('http://localhost:5173/#/streams', { waitUntil: 'networkidle', timeout: 15000 });
    await page.screenshot({ path: '.sisyphus/evidence/final-qa/s5-initial-load.png' });

    // Dump all data-testid to understand page structure
    const allDataTestids = await page.locator('[data-testid]').evaluateAll(els => els.map(e => e.dataset.testid));
    console.log('All data-testid:', JSON.stringify(allDataTestids));

    const allButtons = await page.locator('button').allTextContents();
    console.log('All buttons:', JSON.stringify(allButtons));

    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log('Title:', pageTitle, 'URL:', pageUrl);

    // Look for tab-streams test id
    const tabStreams = await page.locator('[data-testid="tab-streams"]').isVisible().catch(() => false);
    console.log('tab-streams visible:', tabStreams);

    // Try clicking the reports tab
    const tabReports = page.locator('[data-testid="tab-reports"]');
    const tabReportsVisible = await tabReports.isVisible().catch(() => false);
    console.log('tab-reports visible:', tabReportsVisible);

    if (tabReportsVisible) {
      await tabReports.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: '.sisyphus/evidence/final-qa/s5-reports-tab-clicked.png' });

      const periodDay = await page.locator('[data-testid="period-day"]').isVisible().catch(() => false);
      console.log('period-day visible after click:', periodDay);

      const hasChart = await page.locator('[data-testid="stats-chart"]').isVisible().catch(() => false);
      const hasEmpty = (await page.locator('text=No data available').isVisible().catch(() => false));
      console.log('has-chart:', hasChart, 'has-empty:', hasEmpty);

      results.scenario5 = tabStreams && tabReportsVisible && periodDay && (hasChart || hasEmpty);
    } else {
      results.scenario5 = false;
    }
  } catch (e) {
    console.log('Scenario 5 error:', e.message);
    results.scenario5 = false;
  }

  // Scenario 6: Period toggle
  try {
    const periodWeek = page.locator('[data-testid="period-week"]');
    const weekVisible = await periodWeek.isVisible().catch(() => false);
    if (weekVisible) {
      await periodWeek.click();
      await page.waitForTimeout(1000);

      const periodMonth = page.locator('[data-testid="period-month"]');
      await periodMonth.click();
      await page.waitForTimeout(1000);

      await page.screenshot({ path: '.sisyphus/evidence/final-qa/f3-reports-tab.png' });
      results.scenario6 = true;
      console.log('Scenario 6: period toggle OK');
    } else {
      await page.screenshot({ path: '.sisyphus/evidence/final-qa/f3-reports-tab.png' });
      console.log('Scenario 6: period buttons not visible');
      results.scenario6 = false;
    }
  } catch (e) {
    console.log('Scenario 6 error:', e.message);
    results.scenario6 = false;
  }

  // Scenario 7: Switch back to Active Streams
  try {
    const tabStreams = page.locator('[data-testid="tab-streams"]');
    const visible = await tabStreams.isVisible().catch(() => false);
    if (visible) {
      await tabStreams.click();
      await page.waitForTimeout(1000);

      const activeStreamsText = await page.locator('text=Active Streams').isVisible().catch(() => false);
      console.log('Active Streams text visible:', activeStreamsText);
      await page.screenshot({ path: '.sisyphus/evidence/final-qa/s7-active-streams.png' });
      results.scenario7 = activeStreamsText;
    } else {
      await page.screenshot({ path: '.sisyphus/evidence/final-qa/s7-active-streams.png' });
      console.log('Scenario 7: tab-streams not visible');
      results.scenario7 = false;
    }
  } catch (e) {
    console.log('Scenario 7 error:', e.message);
    results.scenario7 = false;
  }

  console.log('RESULTS:', JSON.stringify(results));
  await browser.close();
})();
