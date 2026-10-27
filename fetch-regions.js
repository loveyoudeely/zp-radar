const fs = require('node:fs/promises');
const path = require('node:path');

const cities = [
    'Вільнянськ',
    'Оріхів',
    'Гуляйполе',
    'Степногірськ',
    'Василівка',
    'Токмак',
    'Пологи',
    'Кушугум',
    'Новомиколаївка'
];
const geojsonFile = path.join(__dirname, 'districts.geojson');
const requestDelayMs = 1500;

function normalizeName(value) {
    return String(value || '').trim().toLocaleLowerCase('uk-UA');
}

function hasPolygonGeometry(geometry) {
    return geometry
        && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
        && Array.isArray(geometry.coordinates)
        && geometry.coordinates.length > 0;
}

async function fetchCityPolygon(city) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
        q: `${city}, Запорізька область, Україна`,
        polygon_geojson: '1',
        format: 'json',
        limit: '1'
    });

    const response = await fetch(url, {
        headers: { 'User-Agent': 'ZpRadar city boundary downloader' }
    });
    if (!response.ok) {
        throw new Error(`Nominatim повернув HTTP ${response.status}`);
    }

    const results = await response.json();
    const geometry = results[0]?.geojson;
    if (!hasPolygonGeometry(geometry)) {
        throw new Error('полігон не знайдено або відповідь не містить Polygon/MultiPolygon');
    }

    return geometry;
}

async function downloadCities() {
    const geojson = JSON.parse(await fs.readFile(geojsonFile, 'utf8'));
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('districts.geojson має бути GeoJSON FeatureCollection з масивом features');
    }

    const existingCityNames = new Set(
        geojson.features
            .filter(feature => feature.properties?.feature_type === 'city')
            .map(feature => normalizeName(feature.properties.name))
    );
    const failedCities = [];

    for (let index = 0; index < cities.length; index += 1) {
        const city = cities[index];
        if (existingCityNames.has(normalizeName(city))) {
            console.log(`⚠️ ${city} вже є у файлі.`);
        } else {
            console.log(`Шукаю полігон: ${city}...`);
            try {
                const geometry = await fetchCityPolygon(city);
                geojson.features.push({
                    type: 'Feature',
                    properties: { name: city, feature_type: 'city' },
                    geometry
                });
                existingCityNames.add(normalizeName(city));
                console.log(`✅ ${city} додано.`);
            } catch (error) {
                failedCities.push(city);
                console.error(`❌ Не вдалося завантажити ${city}: ${error.message}`);
            }
        }

        if (index < cities.length - 1) {
            await new Promise(resolve => setTimeout(resolve, requestDelayMs));
        }
    }

    const tempFile = `${geojsonFile}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
    await fs.rename(tempFile, geojsonFile);
    console.log(`Оновлено ${geojsonFile}.`);

    if (failedCities.length) {
        throw new Error(`Не вдалося завантажити полігони: ${failedCities.join(', ')}`);
    }
}

downloadCities().catch(error => {
    console.error(`Помилка оновлення GeoJSON: ${error.message}`);
    process.exitCode = 1;
});
