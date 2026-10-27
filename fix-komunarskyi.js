const fs = require('node:fs/promises');
const path = require('node:path');

const query = 'Комунарський район, Запоріжжя';
const geojsonFile = path.join(__dirname, 'districts.geojson');

function hasPolygonGeometry(geometry) {
    return geometry
        && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
        && Array.isArray(geometry.coordinates)
        && geometry.coordinates.length > 0;
}

async function fetchDistrictPolygon() {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
        q: query,
        polygon_geojson: '1',
        format: 'json',
        limit: '1'
    }).toString();

    const response = await fetch(url, {
        headers: { 'User-Agent': 'ZpRadar district boundary downloader' }
    });
    if (!response.ok) {
        throw new Error(`Nominatim повернув HTTP ${response.status}`);
    }

    const results = await response.json();
    const geometry = results[0]?.geojson;
    if (!hasPolygonGeometry(geometry)) {
        throw new Error(`Для запиту "${query}" полігон не знайдено або він некоректний`);
    }

    return geometry;
}

async function addKomunarskyiDistrict() {
    const geojson = JSON.parse(await fs.readFile(geojsonFile, 'utf8'));
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('districts.geojson має бути GeoJSON FeatureCollection з масивом features');
    }

    const alreadyExists = geojson.features.some(feature =>
        String(feature.properties?.name || '').trim().toLocaleLowerCase('uk-UA') === 'комунарський'
    );
    if (alreadyExists) {
        console.log('Комунарський район вже є у districts.geojson; файл не змінено.');
        return;
    }

    const geometry = await fetchDistrictPolygon();
    geojson.features.push({
        type: 'Feature',
        properties: { name: 'Комунарський', feature_type: 'city' },
        geometry
    });

    const tempFile = `${geojsonFile}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
    await fs.rename(tempFile, geojsonFile);
    console.log('Полігон Комунарського району додано до districts.geojson.');
}

addKomunarskyiDistrict().catch(error => {
    console.error(`Не вдалося додати полігон Комунарського району: ${error.message}`);
    process.exitCode = 1;
});
