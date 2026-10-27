require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'dist');
const staticFiles = [
    'index.html',
    'admin.html',
    'parser.html',
    'districts.geojson',
    'oblast.geojson'
];

async function build() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
        throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) before building.');
    }
    if (supabaseKey === process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Do not use SUPABASE_SERVICE_ROLE_KEY in browser configuration.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(supabaseUrl);
    } catch {
        throw new Error('SUPABASE_URL must be a valid HTTPS URL.');
    }
    if (parsedUrl.protocol !== 'https:') {
        throw new Error('SUPABASE_URL must use HTTPS.');
    }

    await fs.mkdir(outputDirectory, { recursive: true });
    for (const file of staticFiles) {
        await fs.copyFile(path.join(projectRoot, file), path.join(outputDirectory, file));
    }

    const config = {
        supabaseUrl: parsedUrl.origin,
        supabaseKey
    };
    await fs.writeFile(
        path.join(outputDirectory, 'config.js'),
        `window.APP_CONFIG = Object.freeze(${JSON.stringify(config)});\n`,
        'utf8'
    );
    console.log(`Built static site in ${path.relative(projectRoot, outputDirectory)}.`);
}

build().catch(error => {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
});
