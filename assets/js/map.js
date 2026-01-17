/**
 * Карта для ИГС lksoftGwebsrv
 * Использует Leaflet с поддержкой WGS84 и OpenStreetMap
 */

const MapManager = {
    map: null,
    layers: {},
    currentCoordinateSystem: 'wgs84',
    filters: {},
    
    // Режим добавления направлений
    addDirectionMode: false,
    selectedWellsForDirection: [],

    // Режим добавления кабеля (ломаная)
    addCableMode: false,
    addCableTypeCode: null, // cable_ground | cable_aerial
    selectedCablePoints: [],

    // Режим добавления кабеля в канализации (выбор каналов)
    addDuctCableMode: false,
    selectedDuctCableChannels: [],

    // Цвета для слоёв
    colors: {
        wells: '#3498db',
        channels: '#9b59b6',
        markers: '#e67e22',
        groundCables: '#27ae60',
        aerialCables: '#f39c12',
        ductCables: '#1abc9c',
    },

    // Цвета статусов
    statusColors: {
        active: '#22c55e',
        inactive: '#71717a',
        damaged: '#ef4444',
        repair: '#f59e0b',
        planned: '#3b82f6',
        decommissioned: '#6b7280',
    },

    /**
     * Инициализация карты
     */
    init() {
        // Создаём карту без начального центра - будет установлен после загрузки объектов
        this.map = L.map('map', {
            center: [66.101137, 76.641269], // Новый Уренгой (WGS84)
            zoom: 10,
            zoomControl: true,
        });

        // Добавляем базовый слой OpenStreetMap
        this.baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19,
        }).addTo(this.map);

        // Инициализируем пустые слои
        this.layers = {
            wells: L.layerGroup().addTo(this.map),
            channels: L.layerGroup().addTo(this.map),
            markers: L.layerGroup().addTo(this.map),
            groundCables: L.layerGroup().addTo(this.map),
            aerialCables: L.layerGroup().addTo(this.map),
            ductCables: L.layerGroup().addTo(this.map),
        };

        // Отслеживание координат курсора
        this.map.on('mousemove', (e) => this.updateCursorCoordinates(e));

        // Клик по карте
        this.map.on('click', (e) => this.onMapClick(e));

        console.log('Карта инициализирована');
    },

    /**
     * Загрузка всех данных
     */
    async loadAllLayers() {
        console.log('Загрузка слоёв карты...');
        
        const results = await Promise.allSettled([
            this.loadWells(),
            this.loadChannelDirections(),
            this.loadMarkerPosts(),
            this.loadCables('ground'),
            this.loadCables('aerial'),
            this.loadCables('duct'),
        ]);
        
        // Проверяем результаты
        const errors = results.filter(r => r.status === 'rejected');
        if (errors.length > 0) {
            console.error('Ошибки загрузки слоёв:', errors);
            App.notify(`Ошибка загрузки ${errors.length} слоёв`, 'warning');
        }
        
        const loaded = results.filter(r => r.status === 'fulfilled').length;
        console.log(`Загружено слоёв: ${loaded}/${results.length}`);
        
        // Подгоняем карту под объекты с небольшой задержкой для гарантии отрисовки
        setTimeout(() => {
            this.fitToAllObjects();
        }, 100);
    },

    /**
     * Загрузка колодцев
     */
    async loadWells() {
        try {
            console.log('Loading wells with filters:', this.filters);
            const response = await API.wells.geojson(this.filters);
            console.log('Wells GeoJSON response:', response);
            
            // Проверяем на ошибку API
            if (response.success === false) {
                console.error('API error loading wells:', response.message);
                return;
            }
            
            // Проверяем что это валидный GeoJSON
            if (!response.type || response.type !== 'FeatureCollection' || !Array.isArray(response.features)) {
                console.error('Invalid GeoJSON response for wells:', response);
                return;
            }
            
            this.layers.wells.clearLayers();
            
            // Фильтруем features с невалидной геометрией
            const validFeatures = response.features.filter(f => f && f.geometry && f.geometry.type);
            console.log('Valid wells features:', validFeatures.length);
            
            if (validFeatures.length > 0) {
                L.geoJSON({ type: 'FeatureCollection', features: validFeatures }, {
                    pointToLayer: (feature, latlng) => {
                        const color = feature.properties.status_color || this.colors.wells;
                        return L.circleMarker(latlng, {
                            radius: 8,
                            fillColor: color,
                            color: '#fff',
                            weight: 2,
                            opacity: 1,
                            fillOpacity: 0.8,
                        });
                    },
                    onEachFeature: (feature, layer) => {
                        layer.on('click', (e) => {
                            // Проверяем режим добавления направления
                            if (this.addDirectionMode) {
                                L.DomEvent.stopPropagation(e);
                                const coords = layer.getLatLng();
                                this.handleWellClickForDirection({
                                    id: feature.properties.id,
                                    number: feature.properties.number,
                                    lat: coords.lat,
                                    lng: coords.lng
                                });
                                return;
                            }
                            this.showObjectInfo('well', feature.properties);
                        });
                        
                        // Popup при наведении
                        layer.bindTooltip(`
                            <strong>Колодец: ${feature.properties.number}</strong><br>
                            Тип: ${feature.properties.type_name || '-'}<br>
                            Статус: ${feature.properties.status_name || '-'}
                        `, { permanent: false, direction: 'top' });
                    },
                }).addTo(this.layers.wells);
            }
        } catch (error) {
            console.error('Ошибка загрузки колодцев:', error);
        }
    },

    /**
     * Загрузка направлений каналов
     */
    async loadChannelDirections() {
        try {
            const response = await API.channelDirections.geojson(this.filters);
            
            // Проверяем на ошибку API
            if (response.success === false) {
                console.error('API error loading channels:', response.message);
                return;
            }
            
            // Проверяем что это валидный GeoJSON
            if (!response.type || response.type !== 'FeatureCollection' || !Array.isArray(response.features)) {
                console.error('Invalid GeoJSON response for channels');
                return;
            }
            
            this.layers.channels.clearLayers();
            
            // Фильтруем features с невалидной геометрией
            const validFeatures = response.features.filter(f => f && f.geometry && f.geometry.type);
            
            if (validFeatures.length > 0) {
                L.geoJSON({ type: 'FeatureCollection', features: validFeatures }, {
                    style: (feature) => ({
                        color: feature.properties.type_color || this.colors.channels,
                        weight: 3,
                        opacity: 0.8,
                    }),
                    onEachFeature: (feature, layer) => {
                        layer.on('click', async (e) => {
                            if (this.addDuctCableMode) {
                                L.DomEvent.stopPropagation(e);
                                await this.handleDirectionClickForDuctCable(feature.properties?.id);
                                return;
                            }
                            this.showObjectInfo('channel_direction', feature.properties);
                        });
                        
                        layer.bindTooltip(`
                            <strong>Направление: ${feature.properties.number}</strong><br>
                            ${feature.properties.start_well || '-'} → ${feature.properties.end_well || '-'}<br>
                            Каналов: ${feature.properties.channels || 0}
                        `, { permanent: false, sticky: true });
                    },
                }).addTo(this.layers.channels);
            }
        } catch (error) {
            console.error('Ошибка загрузки направлений:', error);
        }
    },

    /**
     * Загрузка столбиков
     */
    async loadMarkerPosts() {
        try {
            const response = await API.markerPosts.geojson(this.filters);
            
            // Проверяем на ошибку API
            if (response.success === false) {
                console.error('API error loading markers:', response.message);
                return;
            }
            
            // Проверяем что это валидный GeoJSON
            if (!response.type || response.type !== 'FeatureCollection' || !Array.isArray(response.features)) {
                console.error('Invalid GeoJSON response for markers');
                return;
            }
            
            this.layers.markers.clearLayers();
            
            // Фильтруем features с невалидной геометрией
            const validFeatures = response.features.filter(f => f && f.geometry && f.geometry.type);
            
            if (validFeatures.length > 0) {
                L.geoJSON({ type: 'FeatureCollection', features: validFeatures }, {
                    pointToLayer: (feature, latlng) => {
                        const color = feature.properties.status_color || this.colors.markers;
                        return L.marker(latlng, {
                            icon: L.divIcon({
                                html: `<i class="fas fa-map-marker-alt" style="color: ${color}; font-size: 24px;"></i>`,
                                className: 'marker-post-icon',
                                iconSize: [24, 24],
                                iconAnchor: [12, 24],
                            }),
                        });
                    },
                    onEachFeature: (feature, layer) => {
                        layer.on('click', () => this.showObjectInfo('marker_post', feature.properties));
                        
                        layer.bindTooltip(`
                            <strong>Столбик: ${feature.properties.number || '-'}</strong><br>
                            Статус: ${feature.properties.status_name || '-'}
                        `, { permanent: false, direction: 'top' });
                    },
                }).addTo(this.layers.markers);
            }
        } catch (error) {
            console.error('Ошибка загрузки столбиков:', error);
        }
    },

    /**
     * Загрузка кабелей
     */
    async loadCables(type) {
        try {
            const response = await API.unifiedCables.geojson(this.filters);
            
            // Проверяем на ошибку API
            if (response.success === false) {
                console.error(`API error loading ${type} cables:`, response.message);
                return;
            }
            
            // Проверяем что это валидный GeoJSON
            if (!response.type || response.type !== 'FeatureCollection' || !Array.isArray(response.features)) {
                console.error(`Invalid GeoJSON response for ${type} cables`);
                return;
            }
            
            const layerName = type + 'Cables';
            this.layers[layerName].clearLayers();
            
            const color = this.colors[layerName];
            const codeMap = { ground: 'cable_ground', aerial: 'cable_aerial', duct: 'cable_duct' };
            const targetCode = codeMap[type];
            
            // Фильтруем features с невалидной геометрией
            const validFeatures = response.features
                .filter(f => f && f.geometry && f.geometry.type)
                .filter(f => !targetCode || f.properties?.object_type_code === targetCode);
            
            if (validFeatures.length > 0) {
                L.geoJSON({ type: 'FeatureCollection', features: validFeatures }, {
                    style: (feature) => ({
                        color: feature.properties.object_type_color || feature.properties.status_color || color,
                        weight: 2,
                        opacity: 0.8,
                        dashArray: type === 'aerial' ? '5, 5' : null,
                    }),
                    onEachFeature: (feature, layer) => {
                        layer.on('click', () => this.showObjectInfo('unified_cable', feature.properties));
                        
                        const typeName = {
                            ground: 'в грунте',
                            aerial: 'воздушный',
                            duct: 'в канализации',
                        }[type];
                        
                        layer.bindTooltip(`
                            <strong>Кабель ${typeName}: ${feature.properties.number || '-'}</strong><br>
                            Волокон: ${feature.properties.fiber_count || '-'}<br>
                            Статус: ${feature.properties.status_name || '-'}
                        `, { permanent: false, sticky: true });
                    },
                }).addTo(this.layers[layerName]);
            }
        } catch (error) {
            console.error(`Ошибка загрузки кабелей ${type}:`, error);
        }
    },

    /**
     * Переключение видимости слоя
     */
    toggleLayer(layerName, visible) {
        const layer = this.layers[layerName];
        if (layer) {
            if (visible) {
                this.map.addLayer(layer);
            } else {
                this.map.removeLayer(layer);
            }
        }
    },

    /**
     * Применение фильтров
     */
    setFilters(filters) {
        this.filters = filters;
        this.loadAllLayers();
    },

    /**
     * Сброс фильтров
     */
    clearFilters() {
        this.filters = {};
        this.loadAllLayers();
    },

    /**
     * Показ информации об объекте
     */
    showObjectInfo(objectType, properties) {
        const infoPanel = document.getElementById('object-info-panel');
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        
        // Определяем название типа объекта
        const typeNames = {
            well: 'Колодец',
            channel_direction: 'Направление канала',
            marker_post: 'Указательный столбик',
            ground_cable: 'Кабель в грунте',
            aerial_cable: 'Воздушный кабель',
            duct_cable: 'Кабель в канализации',
            unified_cable: 'Кабель',
        };

        infoTitle.textContent = `${typeNames[objectType] || 'Объект'}: ${properties.number || properties.id}`;
        
        // Формируем содержимое
        let html = '';
        
        const fields = {
            number: 'Номер',
            type_name: 'Вид',
            kind_name: 'Тип',
            status_name: 'Состояние',
            owner_name: 'Собственник',
            fiber_count: 'Кол-во волокон',
            length_m: 'Длина (м)',
            start_well: 'Начало',
            end_well: 'Конец',
            channels: 'Каналов',
        };

        for (const [key, label] of Object.entries(fields)) {
            if (properties[key] !== undefined && properties[key] !== null) {
                html += `<div class="info-row">
                    <span class="info-label">${label}:</span>
                    <span class="info-value">${properties[key]}</span>
                </div>`;
            }
        }

        infoContent.innerHTML = html;
        
        // Сохраняем данные для редактирования
        infoPanel.dataset.objectType = objectType;
        infoPanel.dataset.objectId = properties.id;
        
        infoPanel.classList.remove('hidden');
    },

    /**
     * Скрытие панели информации
     */
    hideObjectInfo() {
        document.getElementById('object-info-panel').classList.add('hidden');
    },

    /**
     * Обновление координат курсора
     */
    updateCursorCoordinates(e) {
        const lat = e.latlng.lat.toFixed(6);
        const lng = e.latlng.lng.toFixed(6);
        
        document.getElementById('coords-wgs84').textContent = `WGS84: ${lat}, ${lng}`;
        
        // Для МСК86 нужна конвертация на сервере (упрощённо показываем заглушку)
        document.getElementById('coords-msk86').textContent = `МСК86: -`;
    },

    /**
     * Клик по карте (для добавления объектов)
     */
    onMapClick(e) {
        // Если включён режим добавления кабеля (ломаная линия)
        if (this.addCableMode) {
            this.handleAddCableClick(e.latlng);
            return;
        }
        // Если включён режим добавления объекта
        if (this.addingObject) {
            this.handleAddObjectClick(e.latlng);
        }
    },

    /**
     * Старт режима добавления кабеля (ломаная линия)
     */
    startAddCableMode(typeCode) {
        this.addCableMode = true;
        this.addCableTypeCode = typeCode;
        this.selectedCablePoints = [];
        this.map.getContainer().style.cursor = 'crosshair';

        const statusEl = document.getElementById('add-mode-status');
        const textEl = document.getElementById('add-mode-text');
        const finishBtn = document.getElementById('btn-finish-add-mode');
        statusEl.classList.remove('hidden');
        if (finishBtn) finishBtn.classList.remove('hidden');
        textEl.textContent = 'Кликните точки ломаной (минимум 2), затем нажмите «Создать»';

        App.notify('Режим добавления кабеля: укажите точки ломаной', 'info');
    },

    /**
     * Отмена режима добавления кабеля
     */
    cancelAddCableMode() {
        if (!this.addCableMode) return;
        this.addCableMode = false;
        this.addCableTypeCode = null;
        this.selectedCablePoints = [];
        this.map.getContainer().style.cursor = '';

        const finishBtn = document.getElementById('btn-finish-add-mode');
        if (finishBtn) finishBtn.classList.add('hidden');

        // Чистим временные слои
        if (this.tempCableLine) {
            this.map.removeLayer(this.tempCableLine);
            this.tempCableLine = null;
        }
        if (this.tempCableMarkers) {
            this.tempCableMarkers.forEach(m => this.map.removeLayer(m));
            this.tempCableMarkers = [];
        }

        // Скрываем статус, если не активны другие режимы
        if (!this.addDirectionMode && !this.addingObject) {
            document.getElementById('add-mode-status').classList.add('hidden');
        }
    },

    startAddDuctCableMode() {
        this.addDuctCableMode = true;
        this.selectedDuctCableChannels = [];
        this.map.getContainer().style.cursor = 'crosshair';

        const statusEl = document.getElementById('add-mode-status');
        const textEl = document.getElementById('add-mode-text');
        const finishBtn = document.getElementById('btn-finish-add-mode');
        statusEl.classList.remove('hidden');
        if (finishBtn) finishBtn.classList.remove('hidden');
        textEl.textContent = 'Кликните на направлениях и выберите каналы. Затем нажмите «Создать»';

        App.notify('Режим добавления кабеля в канализации: выберите каналы', 'info');
    },

    cancelAddDuctCableMode() {
        if (!this.addDuctCableMode) return;
        this.addDuctCableMode = false;
        this.selectedDuctCableChannels = [];
        this.map.getContainer().style.cursor = '';

        const finishBtn = document.getElementById('btn-finish-add-mode');
        if (finishBtn) finishBtn.classList.add('hidden');

        if (!this.addDirectionMode && !this.addingObject && !this.addCableMode) {
            document.getElementById('add-mode-status').classList.add('hidden');
        }
    },

    async handleDirectionClickForDuctCable(directionId) {
        if (!directionId) return;
        try {
            const resp = await API.channelDirections.get(directionId);
            if (!resp || resp.success === false) {
                App.notify(resp?.message || 'Ошибка загрузки направления', 'error');
                return;
            }
            const dir = resp.data || resp;
            const channels = dir.channels || [];

            const content = `
                <form id="duct-cable-channels-form">
                    <p><strong>${dir.number || 'Направление'}</strong></p>
                    <div style="max-height: 220px; overflow-y: auto; border: 1px solid var(--border-color); padding: 8px; border-radius: 6px;">
                        ${channels.length ? channels.map(ch => `
                            <label style="display:block; margin-bottom:6px;">
                                <input type="checkbox" name="channel_ids" value="${ch.id}">
                                Канал ${ch.channel_number}${ch.kind_name ? ` (${ch.kind_name})` : ''}
                            </label>
                        `).join('') : '<p class="text-muted">В направлении нет каналов</p>'}
                    </div>
                </form>
            `;

            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-primary" onclick="MapManager.addSelectedDuctChannelsFromModal()">Добавить</button>
            `;

            App.showModal('Выбор каналов', content, footer);
        } catch (e) {
            console.error('Ошибка выбора каналов:', e);
            App.notify('Ошибка загрузки направления', 'error');
        }
    },

    addSelectedDuctChannelsFromModal() {
        const form = document.getElementById('duct-cable-channels-form');
        if (!form) return;
        const ids = Array.from(form.querySelectorAll('input[name="channel_ids"]:checked')).map(i => parseInt(i.value));
        ids.forEach(id => {
            if (!this.selectedDuctCableChannels.includes(id)) this.selectedDuctCableChannels.push(id);
        });

        App.hideModal();
        const textEl = document.getElementById('add-mode-text');
        if (textEl) textEl.textContent = `Выбрано каналов: ${this.selectedDuctCableChannels.length}. Нажмите «Создать»`;
        App.notify(`Выбрано каналов: ${this.selectedDuctCableChannels.length}`, 'success');
    },

    finishAddCableMode() {
        // Если активен режим duct — создаём duct кабель
        if (this.addDuctCableMode) {
            if (this.selectedDuctCableChannels.length < 1) {
                App.notify('Выберите минимум 1 канал', 'warning');
                return;
            }
            const selected = [...this.selectedDuctCableChannels];
            this.cancelAddDuctCableMode();
            App.showAddDuctCableModalFromMap(selected);
            return;
        }

        // Иначе — обычный режим ломаной (грунт/воздух)
        if (!this.addCableMode) return;
        if (this.selectedCablePoints.length < 2) {
            App.notify('Нужно указать минимум 2 точки', 'warning');
            return;
        }

        const typeCode = this.addCableTypeCode;
        const coords = [...this.selectedCablePoints];

        this.cancelAddCableMode();

        App.showAddCableModalFromMap(typeCode, coords);
    },

    /**
     * Клик по карте в режиме добавления кабеля
     */
    handleAddCableClick(latlng) {
        if (!this.addCableMode) return;

        // Сохраняем как WGS84 lon/lat для формы
        this.selectedCablePoints.push([parseFloat(latlng.lng.toFixed(6)), parseFloat(latlng.lat.toFixed(6))]);

        // Маркер точки
        if (!this.tempCableMarkers) this.tempCableMarkers = [];
        const marker = L.circleMarker([latlng.lat, latlng.lng], {
            radius: 6,
            fillColor: '#3b82f6',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9,
        }).addTo(this.map);
        this.tempCableMarkers.push(marker);

        // Линия
        const latLngs = this.selectedCablePoints.map(p => [p[1], p[0]]);
        if (!this.tempCableLine) {
            this.tempCableLine = L.polyline(latLngs, { color: '#3b82f6', weight: 3, opacity: 0.9 }).addTo(this.map);
        } else {
            this.tempCableLine.setLatLngs(latLngs);
        }

        const textEl = document.getElementById('add-mode-text');
        if (textEl) textEl.textContent = `Точек: ${this.selectedCablePoints.length}. Нажмите «Создать» когда готово`;
    },

    /**
     * Начало режима добавления направления
     */
    startAddDirectionMode() {
        this.addDirectionMode = true;
        this.selectedWellsForDirection = [];
        this.map.getContainer().style.cursor = 'crosshair';
        
        // Показываем статус
        const statusEl = document.getElementById('add-mode-status');
        const textEl = document.getElementById('add-mode-text');
        statusEl.classList.remove('hidden');
        textEl.textContent = 'Выберите первый колодец';
        
        // Подсвечиваем кнопку
        document.getElementById('btn-add-direction-map').classList.add('active');
        
        App.notify('Кликните на первый колодец', 'info');
    },

    /**
     * Отмена режима добавления направления
     */
    cancelAddDirectionMode() {
        this.addDirectionMode = false;
        this.selectedWellsForDirection = [];
        this.map.getContainer().style.cursor = '';
        
        // Скрываем статус
        document.getElementById('add-mode-status').classList.add('hidden');
        
        // Убираем подсветку кнопки
        document.getElementById('btn-add-direction-map')?.classList.remove('active');
        
        // Удаляем временные маркеры
        if (this.tempMarkers) {
            this.tempMarkers.forEach(m => this.map.removeLayer(m));
            this.tempMarkers = [];
        }
    },

    /**
     * Обработка выбора колодца для направления
     */
    handleWellClickForDirection(wellData) {
        if (!this.addDirectionMode) return false;
        
        // Проверяем, не выбран ли уже этот колодец
        if (this.selectedWellsForDirection.some(w => w.id === wellData.id)) {
            App.notify('Этот колодец уже выбран', 'warning');
            return true;
        }
        
        // Добавляем колодец
        this.selectedWellsForDirection.push(wellData);
        
        // Добавляем временный маркер выбора
        if (!this.tempMarkers) this.tempMarkers = [];
        const marker = L.circleMarker([wellData.lat, wellData.lng], {
            radius: 12,
            fillColor: '#f59e0b',
            color: '#fff',
            weight: 3,
            opacity: 1,
            fillOpacity: 0.9,
        }).addTo(this.map);
        this.tempMarkers.push(marker);
        
        const textEl = document.getElementById('add-mode-text');
        
        if (this.selectedWellsForDirection.length === 1) {
            // Первый колодец выбран
            textEl.textContent = `Первый: ${wellData.number}. Выберите второй колодец`;
            App.notify(`Выбран: ${wellData.number}. Теперь выберите второй колодец`, 'info');
        } else if (this.selectedWellsForDirection.length === 2) {
            // Второй колодец выбран - открываем модальное окно
            const startWell = this.selectedWellsForDirection[0];
            const endWell = this.selectedWellsForDirection[1];
            
            // Сбрасываем режим
            this.cancelAddDirectionMode();
            
            // Открываем модальное окно добавления направления
            App.showAddDirectionModalWithWells(startWell, endWell);
        }
        
        return true; // Сообщаем, что клик обработан
    },

    /**
     * Начало добавления объекта
     */
    startAddingObject(type) {
        this.addingObject = type;
        this.map.getContainer().style.cursor = 'crosshair';
        App.notify('Кликните на карте для указания местоположения', 'info');
    },

    /**
     * Обработка клика при добавлении объекта
     */
    handleAddObjectClick(latlng) {
        const type = this.addingObject;
        this.addingObject = null;
        this.map.getContainer().style.cursor = '';
        
        // Открываем модальное окно с заполненными координатами
        App.showAddObjectModal(type, latlng.lat, latlng.lng);
    },

    /**
     * Отмена добавления объекта
     */
    cancelAddingObject() {
        this.addingObject = null;
        this.map.getContainer().style.cursor = '';
    },

    /**
     * Подгонка карты под все объекты
     */
    fitToAllObjects() {
        const allBounds = [];
        
        // Собираем bounds со всех слоёв
        for (const [layerName, layer] of Object.entries(this.layers)) {
            const layerCount = layer.getLayers().length;
            console.log(`Слой ${layerName}: ${layerCount} объектов`);
            
            if (layerCount > 0) {
                try {
                    const bounds = layer.getBounds();
                    if (bounds && bounds.isValid()) {
                        allBounds.push(bounds);
                        console.log(`Bounds для ${layerName}:`, bounds.toBBoxString());
                    }
                } catch (e) {
                    console.warn(`Не удалось получить bounds для ${layerName}:`, e);
                }
            }
        }

        console.log(`Всего слоёв с данными: ${allBounds.length}`);

        if (allBounds.length > 0) {
            let combinedBounds = allBounds[0];
            for (let i = 1; i < allBounds.length; i++) {
                combinedBounds = combinedBounds.extend(allBounds[i]);
            }
            
            console.log('Итоговые bounds:', combinedBounds.toBBoxString());
            
            // Устанавливаем максимальный зум 17 для комфортного просмотра
            this.map.fitBounds(combinedBounds, { 
                padding: [50, 50], 
                maxZoom: 17,
                animate: true 
            });
            console.log('Карта подогнана под все объекты');
        } else {
            console.log('Нет объектов для подгонки карты - оставляем центр по умолчанию');
        }
    },

    /**
     * Подгонка карты под конкретный объект с комфортным зумом
     */
    fitToObject(lat, lng, objectType = 'point') {
        if (objectType === 'point') {
            // Для точечных объектов устанавливаем комфортный зум 16
            this.map.setView([lat, lng], 16, { animate: true });
        } else {
            this.map.flyTo([lat, lng], 16);
        }
    },

    /**
     * Подгонка карты под bounds (для групп и линейных объектов)
     */
    fitToBounds(bounds, maxZoom = 17) {
        if (bounds && bounds.isValid()) {
            this.map.fitBounds(bounds, { padding: [80, 80], maxZoom: maxZoom });
        }
    },

    /**
     * Переход к объекту с комфортным зумом
     */
    flyToObject(lat, lng, zoom = 16) {
        this.map.flyTo([lat, lng], zoom);
    },

    /**
     * Показать объект по ID и типу - найти его координаты и перейти к нему
     */
    async showObjectOnMap(objectType, objectId) {
        try {
            let response;
            let lat, lng;
            let bounds = null;

            switch (objectType) {
                case 'wells':
                case 'well':
                    response = await API.wells.get(objectId);
                    if (response.success && response.data) {
                        lat = response.data.latitude;
                        lng = response.data.longitude;
                    }
                    break;

                case 'markers':
                case 'marker_post':
                    response = await API.markerPosts.get(objectId);
                    if (response.success && response.data) {
                        lat = response.data.latitude;
                        lng = response.data.longitude;
                    }
                    break;

                case 'directions':
                case 'channels':
                case 'channel_direction':
                    response = await API.channelDirections.get(objectId);
                    if (response.success && response.data && response.data.geometry) {
                        const geom = typeof response.data.geometry === 'string' 
                            ? JSON.parse(response.data.geometry) 
                            : response.data.geometry;
                        if (geom && geom.coordinates) {
                            // Для линии берём центр
                            const coords = geom.coordinates;
                            const midIdx = Math.floor(coords.length / 2);
                            lng = coords[midIdx][0];
                            lat = coords[midIdx][1];
                            // Создаём bounds для линии
                            const latLngs = coords.map(c => [c[1], c[0]]);
                            bounds = L.latLngBounds(latLngs);
                        }
                    }
                    break;

                case 'groups':
                    // Загружаем GeoJSON группы и подгоняем под все объекты
                    response = await API.groups.geojson(objectId);
                    if (response.type === 'FeatureCollection' && response.features.length > 0) {
                        const groupLayer = L.geoJSON(response);
                        bounds = groupLayer.getBounds();
                    }
                    break;

                case 'cables':
                case 'ground_cable':
                case 'aerial_cable':
                case 'duct_cable':
                    const cableType = objectType === 'cables' ? 'ground' : objectType.replace('_cable', '');
                    response = await API.cables.get(cableType, objectId);
                    if (response.success && response.data && response.data.geometry) {
                        const geom = typeof response.data.geometry === 'string' 
                            ? JSON.parse(response.data.geometry) 
                            : response.data.geometry;
                        if (geom && geom.coordinates) {
                            const coords = geom.coordinates.flat();
                            const midIdx = Math.floor(coords.length / 2);
                            lng = coords[midIdx][0];
                            lat = coords[midIdx][1];
                            const latLngs = coords.map(c => [c[1], c[0]]);
                            bounds = L.latLngBounds(latLngs);
                        }
                    }
                    break;
                    
                case 'unified_cables':
                    response = await API.unifiedCables.get(objectId);
                    if (response.success && response.data && response.data.geometry) {
                        const geom = typeof response.data.geometry === 'string' 
                            ? JSON.parse(response.data.geometry) 
                            : response.data.geometry;
                        if (geom && geom.coordinates) {
                            const coords = geom.coordinates.flat();
                            const midIdx = Math.floor(coords.length / 2);
                            lng = coords[midIdx][0];
                            lat = coords[midIdx][1];
                            const latLngs = coords.map(c => [c[1], c[0]]);
                            bounds = L.latLngBounds(latLngs);
                        }
                    }
                    break;
            }

            // Переключаемся на панель карты
            App.switchPanel('map');

            // Фокусируемся на объекте
            setTimeout(() => {
                if (bounds && bounds.isValid()) {
                    this.fitToBounds(bounds, 17);
                } else if (lat && lng) {
                    this.flyToObject(lat, lng, 16);
                } else {
                    App.notify('Не удалось определить координаты объекта', 'warning');
                }
            }, 100);

        } catch (error) {
            console.error('Ошибка показа объекта на карте:', error);
            App.notify('Ошибка загрузки данных объекта', 'error');
        }
    },

    /**
     * Переключение системы координат
     */
    setCoordinateSystem(system) {
        this.currentCoordinateSystem = system;
        
        if (system === 'msk86') {
            // Скрываем OpenStreetMap
            this.map.removeLayer(this.baseLayer);
            // Можно добавить другой базовый слой для МСК86
        } else {
            // Показываем OpenStreetMap
            this.baseLayer.addTo(this.map);
        }
    },

    /**
     * Загрузка группы объектов
     * @param {number} groupId ID группы
     * @param {object} additionalFilters Дополнительные фильтры (owner_id, status_id, contract_id)
     */
    async loadGroup(groupId, additionalFilters = {}) {
        try {
            const response = await API.groups.geojson(groupId);
            
            // Проверяем на ошибку API
            if (response.success === false) {
                console.error('API error loading group:', response.message);
                App.notify(response.message || 'Ошибка загрузки группы', 'error');
                return;
            }
            
            // Проверяем что это валидный GeoJSON
            if (!response.type || response.type !== 'FeatureCollection' || !Array.isArray(response.features)) {
                console.error('Invalid GeoJSON response for group');
                App.notify('Ошибка загрузки группы', 'error');
                return;
            }
            
            // Очищаем все слои
            for (const layer of Object.values(this.layers)) {
                layer.clearLayers();
            }
            
            // Фильтруем features с невалидной геометрией
            let validFeatures = response.features.filter(f => f && f.geometry && f.geometry.type);
            
            // Применяем дополнительные фильтры если указаны
            if (Object.keys(additionalFilters).length > 0) {
                validFeatures = validFeatures.filter(f => {
                    const props = f.properties || {};
                    if (additionalFilters.owner_id && props.owner_id != additionalFilters.owner_id) return false;
                    if (additionalFilters.status_id && props.status_id != additionalFilters.status_id) return false;
                    if (additionalFilters.contract_id && props.contract_id != additionalFilters.contract_id) return false;
                    return true;
                });
            }
            
            if (validFeatures.length > 0) {
                // Загружаем объекты группы
                L.geoJSON({ type: 'FeatureCollection', features: validFeatures }, {
                    pointToLayer: (feature, latlng) => {
                        const color = feature.properties.object_type === 'well' 
                            ? this.colors.wells 
                            : this.colors.markers;
                        return L.circleMarker(latlng, {
                            radius: 8,
                            fillColor: color,
                            color: '#fff',
                            weight: 2,
                            opacity: 1,
                            fillOpacity: 0.8,
                        });
                    },
                    style: (feature) => ({
                        color: this.colors.channels,
                        weight: 3,
                        opacity: 0.8,
                    }),
                    onEachFeature: (feature, layer) => {
                        layer.on('click', () => this.showObjectInfo(feature.properties.object_type, feature.properties));
                    },
                }).addTo(this.layers.wells);
                
                this.fitToAllObjects();
            }
            
            const groupName = response.properties?.group_name || 'Без имени';
            App.notify(`Загружена группа: ${groupName}`, 'success');
        } catch (error) {
            console.error('Ошибка загрузки группы:', error);
            App.notify('Ошибка загрузки группы', 'error');
        }
    },
};
