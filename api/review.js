const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// URL frontend Dart Runner-nya sendiri (satu domain yang sama).
// Otomatis dideteksi dari host request, jadi kalau domain kamu ganti, tetap jalan.
function getRunnerUrl(req) {
  if (process.env.RUNNER_URL) return process.env.RUNNER_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}/`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Gunakan method POST.' });
    return;
  }

  const { code } = req.body || {};
  if (!code || typeof code !== 'string' || !code.trim()) {
    res.status(400).json({
      success: false,
      error: 'Field "code" (string berisi kode Dart) wajib diisi di body JSON.',
    });
    return;
  }

  const RUNNER_URL = getRunnerUrl(req);
  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 900, height: 700 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(RUNNER_URL, { waitUntil: 'networkidle2', timeout: 25000 });

    // Tunggu iframe DartPad siap
    await page.waitForFunction(() => {
      const el = document.querySelector('#status');
      return el && el.textContent.trim() !== 'memuat...';
    }, { timeout: 15000 });

    // Suntikkan kode ke editor
    await page.evaluate((sourceCode) => {
      const ta = document.querySelector('#editor');
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      nativeSetter.call(ta, sourceCode);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, code);

    await page.click('#runBtn');

    // Beri waktu compile + render (ini bagian paling lama)
    await new Promise((r) => setTimeout(r, 8000));

    // Deteksi error compile dari isi iframe DartPad
    let hasError = false;
    let errorText = '';
    try {
      const iframeHandle = await page.$('#dartpad');
      const frame = await iframeHandle.contentFrame();
      const bodyText = await frame.evaluate(() => document.body.innerText);
      if (/Error:/i.test(bodyText)) {
        hasError = true;
        errorText = bodyText.slice(0, 1000);
      }
    } catch (e) {
      // gagal baca cross-origin, lanjut tetap screenshot
    }

    // Screenshot panel Output (kolom kanan)
    const panes = await page.$$('.pane');
    const outputPane = panes[1];
    const box = await outputPane.boundingBox();
    const buf = await page.screenshot({ clip: box, type: 'png' });

    await browser.close();

    res.status(200).json({
      success: !hasError,
      error: hasError ? errorText : null,
      image_base64: buf.toString('base64'),
      mime_type: 'image/png',
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
};
      
