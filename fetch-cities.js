const fs = require('fs');

const cities = ['Вільнянськ', 'Оріхів', 'Гуляйполе', 'Степногірськ', 'Василівка', 'Кушугум', 'Новомиколаївка'];
const geojsonFile = 'districts.geojson';

async function downloadCities() {
    let geojson = JSON.parse(fs.readFileSync(geojsonFile, 'utf8'));
    
    for (const city of cities) {
        console.log(`Шукаю координати: ${city}...`);
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}, Запорізька область, Україна&polygon_geojson=1&format=json&limit=1`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data && data.length > 0 && data[0].geojson) {
                // Проверяем, нет ли уже такого города, чтобы не дублировать
                const exists = geojson.features.some(f => f.properties.name === city);
                if (!exists) {
                    geojson.features.push({
                        type: "Feature",
                        properties: { name: city, feature_type: "city" },
                        geometry: data[0].geojson
                    });
                    console.log(`✅ ${city} успішно додано.`);
                } else {
                    console.log(`⚠️ ${city} вже є у файлі.`);
                }
            } else {
                console.log(`❌ Полігон для ${city} не знайдено.`);
            }
        } catch (error) {
            console.error(`Помилка мережі для ${city}:`, error.message);
        }
        
        // Пауза 1.5 секунды, чтобы API OpenStreetMap не заблокировал за спам
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    fs.writeFileSync(geojsonFile, JSON.stringify(geojson, null, 2));
    console.log('🎉 Оновлення districts.geojson завершено!');
}

downloadCities();
