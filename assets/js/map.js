/**
 * Карта для ИГС lksoftGwebsrv
 * Использует Leaflet с поддержкой WGS84 и OpenStreetMap
 */

const MapManager = {
    map: null,
    layers: {},
    currentCoordinateSystem: 'wgs84',
    filters: {},
    defaultCenter: [66.10231, 76.68617],
    defaultZoom: 14,
    
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

    // Подсветка маршрута (направления) выбранного кабеля
    highlightLayer: null,
    selectedLayer: null,
    lastClickHits: [],
    hoverHits: [],
    incidentSelectMode: false,

    // Подписи колодцев
    wellLabelsEnabled: false,
    wellLabelsLayer: null,
    wellLabelsMinZoom: 14,
    // Подписи координат (колодцы + столбики)
    objectCoordinatesLabelsEnabled: false,
    objectCoordinatesLabelsLayer: null,
    objectCoordinatesLabelsMinZoom: 14,
    // Подписи длины направлений
    directionLengthLabelsEnabled: false,
    directionLengthLabelsLayer: null,
    // Легенда по собственникам (раскраска по owners.color)
    ownersLegendEnabled: false,
    ownersLegendEl: null,
    _ownersLegendCache: null,
    _lastGroupFilters: null,
    // Панель "Настройки по умолчанию" (персональные дефолты)
    mapDefaultsEnabled: false,
    mapDefaultsEl: null,
    // Множественный выбор объектов на карте
    multiSelected: new Map(), // key => { objectType, properties }
    // Базовые слои карты: OSM (по умолчанию) + Спутник (WMTS ЯНАО)
    osmBaseLayer: null,
    wmtsSatelliteLayer: null,
    wmtsSatelliteEnabled: false,
    initialViewLocked: true,

    // Режим группы (показываем только объекты группы)
    groupMode: false,
    activeGroupId: null,

    // Режим выбора объекта на карте для добавления в группу
    groupPickMode: false,
    groupPickGroupId: null,

    // Режим "Набить колодец" (выбор направления)
    stuffWellMode: false,
    // Режим "Переложить кабель в канализации"
    relocateDuctCableMode: false,
    relocateDuctCableId: null,
    relocateDuctCableRouteChannels: [], // [{ cable_channel_id, direction_id, route_order }]
    relocateDuctCablePickCandidates: [],
    relocateDuctCableDirectionPickCandidates: [],
    relocateDuctCablePendingDirection: null, // { directionId, channels: [] }

    // Режим "Переместить точечный объект"
    movePointMode: false,
    movePointSelected: null, // { objectType: 'well'|'marker_post', id, origLatLng, newLatLng }
    movePointMarker: null,
    movePointPickCandidates: [],

    // Режим "Создать кабель в канализации по кратчайшему пути"
    shortestDuctCableMode: false,
    shortestDuctCableStartWell: null, // { id, number }
    shortestDuctCableEndWell: null,   // { id, number }
    shortestDuctCableCableId: null,   // id созданного duct-кабеля (для достраивания по следующим колодцам)
    shortestDuctCableRouteChannelIds: [], // накопленный маршрут cable_channel_id
    shortestDuctCableRouteDirectionIds: [], // накопленный маршрут direction_id (повторы запрещены)
    shortestDuctCableBusy: false,

    // Режим "Инвентаризация" (ввод кабелей по направлениям колодца на карте)
    inventoryMode: false,
    inventoryWell: null, // { id, number }
    inventoryDirectionCounts: {}, // direction_id -> count
    inventoryInputLayer: null,
    inventoryLabelsLayer: null,
    inventoryUnaccountedLabelsEnabled: true,
    _inventoryDirectionsCache: new Map(), // direction_id -> { number, start/end, ... }
    _inventoryCablesPopupCache: new Map(), // direction_id -> html

    // Предполагаемые кабели (слой)
    assumedCablesVariantNo: 1,
    assumedCablesPanelEl: null,
    inventoryRecommendationsPanelEl: null,
    _inventoryRecommendationsOwnerId: null,
    _inventoryRecommendationsSelectedKey: null,
    assumedSegmentPickerEl: null,
    _assumedCablesPanelSelectedKey: null,
    _assumedRouteLayerById: new Map(),
    _assumedRoutesById: new Map(), // route_id -> { ...row, _index, _direction_ids[] }
    _assumedRouteIdsByDirectionId: new Map(), // direction_id -> [route_id...]
    _assumedBaseDirLatLngsById: new Map(), // direction_id -> LatLng[]
    _assumedRoutesPopupHtml: null, // legacy fallback
    _assumedRoutesPopup: null,
    _assumedRoutesPickPopup: null,

    // Линейка (измерение расстояний)
    rulerMode: false,
    rulerLayer: null,
    rulerPoints: [], // [{ latlng, point, label }]
    rulerFixedSegments: [], // [{ line, label, meters }]
    rulerTempLine: null, // линия от последней точки до курсора
    rulerCursorLabel: null, // подпись над курсором
    rulerLastCursorLatLng: null,
    rulerSumMeters: 0,

    // Цвета для слоёв
    colors: {
        wells: '#fa00fa',
        channels: '#fa00fa',
        markers: '#e67e22',
        groundCables: '#551b1b',
        aerialCables: '#009dff',
        ductCables: '#00bd26',
        assumedCables: '#a855f7',
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

    getPlannedOverrideColor(props, fallback) {
        const code = props?.status_code;
        if (code === 'planned' && props?.status_color) return props.status_color;
        return fallback;
    },

    getSettingNumber(code, fallback) {
        try {
            if (typeof App === 'undefined') return fallback;
            const raw = App?.settings?.[code];
            if (raw === undefined || raw === null || raw === '') return fallback;
            const n = Number(raw);
            return Number.isFinite(n) ? n : fallback;
        } catch (_) {
            return fallback;
        }
    },

    getDirectionLineWeight() {
        return Math.max(0.5, this.getSettingNumber('line_weight_direction', 3));
    },

    getCableLineWeight() {
        return Math.max(0.5, this.getSettingNumber('line_weight_cable', 2));
    },

    getWellMarkerSizePx() {
        return Math.max(6, this.getSettingNumber('icon_size_well_marker', 24));
    },

    getWellLabelFontSizePx() {
        return Math.max(8, this.getSettingNumber('font_size_well_number_label', 12));
    },

    getObjectCoordinatesLabelFontSizePx() {
        // По ТЗ размер шрифта берём из "Размер шрифта — номер Колодца"
        return this.getWellLabelFontSizePx();
    },

    getDirectionLengthLabelFontSizePx() {
        return Math.max(8, this.getSettingNumber('font_size_direction_length_label', 12));
    },

    isWellEntryPoint(props) {
        // Важно: App объявлен как const в app.js и не является window.App,
        // поэтому используем доступ по идентификатору App (если определён).
        const entry = (typeof App !== 'undefined' ? (App?.settings?.well_entry_point_kind_code || '') : '').toString().trim();
        if (!entry) return false;
        const kindCode = (props?.kind_code || '').toString().trim();
        return !!kindCode && kindCode === entry;
    },

    isWellPole(props) {
        const kindCode = (props?.kind_code || '').toString().trim().toLowerCase();
        return kindCode === 'pole';
    },

    createWellMarker(latlng, props) {
        const base = props?.type_color || this.colors.wells;
        const legendColor = (props?.owner_color || '').toString().trim();
        const color = (this.ownersLegendEnabled && legendColor)
            ? legendColor
            : this.getPlannedOverrideColor(props, base);
        const size = this.getWellMarkerSizePx(); // диаметр/размер в px
        if (this.isWellEntryPoint(props)) {
            return L.marker(latlng, {
                icon: L.divIcon({
                    className: 'well-entry-point-icon',
                    html: `<div style="width:${size}px;height:${size}px;background:${color};border:2px solid #fff;box-sizing:border-box;opacity:0.85;"></div>`,
                    iconSize: [size, size],
                    iconAnchor: [size / 2, size / 2],
                }),
            });
        }
        if (this.isWellPole(props)) {
            // "Опора" (kind_code = pole): треугольник
            return L.marker(latlng, {
                icon: L.divIcon({
                    className: 'well-pole-icon',
                    html: `
                        <svg width="${size}" height="${size}" viewBox="0 0 100 100" style="display:block;">
                            <polygon points="50,8 95,92 5,92" fill="${color}" stroke="#fff" stroke-width="10" opacity="0.85"></polygon>
                        </svg>
                    `,
                    iconSize: [size, size],
                    iconAnchor: [size / 2, size / 2],
                }),
            });
        }
        const radius = Math.max(3, size / 2);
        return L.circleMarker(latlng, {
            radius,
            fillColor: color,
            // Обводка колодца всегда белая (stroke = #fff), даже в режиме "Легенда по собственникам"
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8,
        });
    },

    createMarkerPostMarker(latlng, props) {
        const base = props?.type_color || this.colors.markers;
        const color = this.getPlannedOverrideColor(props, base);
        const size = this.getWellMarkerSizePx();
        return L.marker(latlng, {
            icon: L.divIcon({
                html: `<i class="fas fa-map-marker-alt" style="color: ${color}; font-size: ${size}px;"></i>`,
                className: 'marker-post-icon',
                iconSize: [size, size],
                iconAnchor: [size / 2, size],
            }),
        });
    },

    setWmtsSatelliteEnabled(enabled) {
        this.wmtsSatelliteEnabled = !!enabled;
        if (!this.map) return;
        if (!this.osmBaseLayer || !this.wmtsSatelliteLayer) return;

        try {
            if (this.wmtsSatelliteEnabled) {
                if (this.map.hasLayer(this.osmBaseLayer)) this.map.removeLayer(this.osmBaseLayer);
                if (!this.map.hasLayer(this.wmtsSatelliteLayer)) this.map.addLayer(this.wmtsSatelliteLayer);
            } else {
                if (this.map.hasLayer(this.wmtsSatelliteLayer)) this.map.removeLayer(this.wmtsSatelliteLayer);
                if (!this.map.hasLayer(this.osmBaseLayer)) this.map.addLayer(this.osmBaseLayer);
            }
        } catch (_) {}
    },

    toggleExternalWmtsLayer() {
        // тумблер "OSM <-> Спутник (WMTS)"
        this.setWmtsSatelliteEnabled(!this.wmtsSatelliteEnabled);
        if (typeof App !== 'undefined') {
            App.notify(this.wmtsSatelliteEnabled ? 'Спутник включён' : 'OSM включён', 'info');
        }
    },

    buildWmtsTileUrlTemplateFromSettings() {
        const s = (typeof App !== 'undefined' ? (App?.settings || {}) : {}) || {};
        const url = (s.wmts_url_template || '').toString().trim();
        const style = (s.wmts_style || 'default').toString().trim();
        const tms = (s.wmts_tilematrixset || 'GoogleMapsCompatible').toString().trim();
        const tm = (s.wmts_tilematrix || '{z}').toString().trim();
        const tr = (s.wmts_tilerow || '{y}').toString().trim();
        const tc = (s.wmts_tilecol || '{x}').toString().trim();

        // если пользователь удалил URL — используем дефолт
        const fallback =
            'https://karta.yanao.ru/ags1/rest/services/basemap/ags1_Imagery_bpla/MapServer/WMTS/tile/1.0.0/' +
            'basemap_ags1_Imagery_bpla/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}';

        const tpl = (url || fallback)
            .replaceAll('{Style}', style || 'default')
            .replaceAll('{TileMatrixSet}', tms || 'GoogleMapsCompatible')
            .replaceAll('{TileMatrix}', tm || '{z}')
            .replaceAll('{TileRow}', tr || '{y}')
            .replaceAll('{TileCol}', tc || '{x}');

        return tpl;
    },

    rebuildWellLabelsFromWellsLayer() {
        if (!this.wellLabelsLayer) return;
        this.wellLabelsLayer.clearLayers();

        const labelColorDefault = this.colors.wells;
        const fontSize = this.getWellLabelFontSizePx();

        const addLabel = (latlng, number, color) => {
            const label = L.marker(latlng, {
                interactive: false,
                keyboard: false,
                icon: L.divIcon({
                    className: 'well-number-label',
                    html: `<div class="well-number-label-text" style="color:${color || labelColorDefault}; font-size:${fontSize}px;">${number}</div>`,
                    iconAnchor: [0, 0],
                }),
            });
            label.addTo(this.wellLabelsLayer);
        };

        try {
            const traverse = (layer) => {
                if (!layer) return;
                if (typeof layer.getLayers === 'function') {
                    (layer.getLayers() || []).forEach(traverse);
                    return;
                }
                const meta = layer?._igsMeta;
                if (!meta || meta.objectType !== 'well') return;
                const coords = layer.getLatLng?.();
                const props = meta.properties || {};
                const number = props.number;
                if (!coords || !number) return;
                const base = props.status_color || props.type_color || this.colors.wells;
                // Важно: "Легенда по собственникам" НЕ должна менять цвет подсказок (номера колодцев).
                // Подсказки всегда рисуем в стандартной цветовой схеме (с учётом planned).
                const color = this.getPlannedOverrideColor(props, base);
                addLabel(coords, number, color);
            };
            Object.values(this.layers || {}).forEach(traverse);
        } catch (_) {
            // ignore
        }
    },

    rebuildObjectCoordinatesLabelsFromPointLayers() {
        if (!this.objectCoordinatesLabelsLayer) return;
        this.objectCoordinatesLabelsLayer.clearLayers();

        const fontSize = this.getObjectCoordinatesLabelFontSizePx();
        const fmt = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return '';
            return n.toFixed(6);
        };

        const addLabel = (latlng) => {
            const lat = fmt(latlng?.lat);
            const lng = fmt(latlng?.lng);
            if (!lat || !lng) return;
            const label = L.marker(latlng, {
                interactive: false,
                keyboard: false,
                icon: L.divIcon({
                    className: 'igs-coords-label',
                    html: `<div class="igs-coords-label-box" style="font-size:${fontSize}px;">${lat}<br>${lng}</div>`,
                    iconSize: [1, 1],
                    iconAnchor: [0, 0],
                }),
            });
            label.addTo(this.objectCoordinatesLabelsLayer);
        };

        const traverse = (layer) => {
            if (!layer) return;
            if (typeof layer.getLayers === 'function') {
                (layer.getLayers() || []).forEach(traverse);
                return;
            }
            const meta = layer?._igsMeta;
            if (!meta) return;
            if (meta.objectType !== 'well' && meta.objectType !== 'marker_post') return;
            const ll = layer.getLatLng?.();
            if (!ll) return;
            addLabel(ll);
        };

        try {
            traverse(this.layers?.wells);
            traverse(this.layers?.markers);
        } catch (_) {
            // ignore
        }
    },

    getTypeDisplayName(objectType) {
        const typeNames = {
            well: 'Колодец',
            channel_direction: 'Направление',
            marker_post: 'Столбик',
            ground_cable: 'Кабель в грунте',
            aerial_cable: 'Воздушный кабель',
            duct_cable: 'Кабель в канализации',
            unified_cable: 'Кабель',
        };
        return typeNames[objectType] || 'Объект';
    },

    setHighlightBarVisible(visible) {
        const el = document.getElementById('highlight-bar');
        if (!el) return;
        el.classList.toggle('hidden', !visible);
    },

    /**
     * Инициализация карты
     */
    init() {
        // Создаём карту с заданным центром/зумом по умолчанию
        this.map = L.map('map', {
            center: this.defaultCenter || [66.10231, 76.68617],
            zoom: this.defaultZoom || 14,
            zoomControl: true,
        });

        // Базовый слой: OSM (по умолчанию)
        this.osmBaseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19,
        }).addTo(this.map);

        // Спутник: WMTS (настраивается в "Настройки -> Настройка слоя WMTS")
        const wmtsTemplate = this.buildWmtsTileUrlTemplateFromSettings();
        this.wmtsSatelliteLayer = L.tileLayer(wmtsTemplate, {
            maxZoom: 22,
            attribution: '&copy; ЯНАО',
        });
        this.wmtsSatelliteEnabled = false;

        // Инициализируем пустые слои
        this.layers = {
            wells: L.featureGroup().addTo(this.map),
            channels: L.featureGroup().addTo(this.map),
            inventory: L.featureGroup().addTo(this.map),
            assumedCables: L.featureGroup().addTo(this.map),
            markers: L.featureGroup().addTo(this.map),
            groundCables: L.featureGroup().addTo(this.map),
            aerialCables: L.featureGroup().addTo(this.map),
            ductCables: L.featureGroup().addTo(this.map),
        };

        // Панели (панes) для порядка отрисовки:
        // - inventory ниже колодцев
        try {
            if (!this.map.getPane('inventoryPane')) {
                this.map.createPane('inventoryPane');
                this.map.getPane('inventoryPane').style.zIndex = '380';
            }
            if (!this.map.getPane('inventoryLabelPane')) {
                this.map.createPane('inventoryLabelPane');
                this.map.getPane('inventoryLabelPane').style.zIndex = '395';
            }
            // Инпуты режима инвентаризации должны быть поверх всех слоёв (выше направлений/подсказок/попапов)
            if (!this.map.getPane('inventoryInputPane')) {
                this.map.createPane('inventoryInputPane');
                this.map.getPane('inventoryInputPane').style.zIndex = '900';
            }
            if (!this.map.getPane('assumedCablesPane')) {
                this.map.createPane('assumedCablesPane');
                this.map.getPane('assumedCablesPane').style.zIndex = '410';
                // нужен hover по предполагаемым кабелям
                this.map.getPane('assumedCablesPane').style.pointerEvents = 'auto';
            }
            if (!this.map.getPane('assumedCablesBasePane')) {
                this.map.createPane('assumedCablesBasePane');
                this.map.getPane('assumedCablesBasePane').style.zIndex = '405';
                this.map.getPane('assumedCablesBasePane').style.pointerEvents = 'none';
            }
            if (!this.map.getPane('rulerLinePane')) {
                this.map.createPane('rulerLinePane');
                this.map.getPane('rulerLinePane').style.zIndex = '920';
                this.map.getPane('rulerLinePane').style.pointerEvents = 'none';
            }
            if (!this.map.getPane('rulerLabelPane')) {
                this.map.createPane('rulerLabelPane');
                this.map.getPane('rulerLabelPane').style.zIndex = '930';
                this.map.getPane('rulerLabelPane').style.pointerEvents = 'none';
            }
            if (!this.map.getPane('highlightPane')) {
                this.map.createPane('highlightPane');
                // Подсветка должна быть выше линий, но ниже попапов/модальных окон
                this.map.getPane('highlightPane').style.zIndex = '550';
                this.map.getPane('highlightPane').style.pointerEvents = 'none';
            }
        } catch (_) {}

        // Отдельный слой подписей колодцев (вкл/выкл через панель инструментов)
        this.wellLabelsLayer = L.featureGroup().addTo(this.map);
        // Отдельный слой подписей координат (колодцы + столбики)
        this.objectCoordinatesLabelsLayer = L.featureGroup().addTo(this.map);
        // Отдельный слой подписей длин направлений
        this.directionLengthLabelsLayer = L.featureGroup().addTo(this.map);
        // Отдельный слой подписей инвентаризации (значение "неучтенных")
        // Добавляем/убираем вместе со слоем inventory
        this.inventoryLabelsLayer = L.featureGroup();
        // Отдельный слой инпутов для режима инвентаризации (режим инструментов, поверх карты)
        this.inventoryInputLayer = L.featureGroup().addTo(this.map);

        // Легенда по собственникам (DOM overlay поверх карты)
        try {
            const host = this.map.getContainer?.();
            if (host) {
                const el = document.createElement('div');
                el.id = 'owners-legend';
                el.className = 'owners-legend hidden';
                host.appendChild(el);
                this.ownersLegendEl = el;
            }
        } catch (_) {}

        // Панель "Настройки по умолчанию" (DOM overlay поверх карты)
        try {
            const host = this.map.getContainer?.();
            if (host) {
                const el = document.createElement('div');
                el.id = 'map-defaults';
                el.className = 'map-defaults hidden';
                host.appendChild(el);
                this.mapDefaultsEl = el;
                // Важно: если курсор над панелью — колесо мыши скроллит панель, а не зумит карту
                try {
                    if (typeof L !== 'undefined' && L?.DomEvent) {
                        L.DomEvent.disableScrollPropagation(el);
                        L.DomEvent.disableClickPropagation(el);
                    }
                } catch (_) {}
                // Доп. страховка для wheel (некоторые браузеры/сборки Leaflet)
                try {
                    el.addEventListener('wheel', (e) => {
                        try { e.stopPropagation(); } catch (_) {}
                    }, { passive: true });
                } catch (_) {}
            }
        } catch (_) {}

        // Панель "Предполагаемые кабели" (DOM overlay поверх карты, справа)
        try {
            const host = this.map.getContainer?.();
            if (host) {
                const el = document.createElement('div');
                el.id = 'assumed-cables-panel';
                el.className = 'assumed-cables-panel hidden';
                host.appendChild(el);
                this.assumedCablesPanelEl = el;
                try {
                    if (typeof L !== 'undefined' && L?.DomEvent) {
                        L.DomEvent.disableScrollPropagation(el);
                        L.DomEvent.disableClickPropagation(el);
                    }
                } catch (_) {}
            }
        } catch (_) {}

        // Панель "Рекомендации по инвентаризации" (DOM overlay поверх карты, справа)
        try {
            const host = this.map.getContainer?.();
            if (host) {
                const el = document.createElement('div');
                el.id = 'inventory-recommendations-panel';
                el.className = 'inventory-reco-panel hidden';
                host.appendChild(el);
                this.inventoryRecommendationsPanelEl = el;
                try {
                    if (typeof L !== 'undefined' && L?.DomEvent) {
                        L.DomEvent.disableScrollPropagation(el);
                        L.DomEvent.disableClickPropagation(el);
                    }
                } catch (_) {}
            }
        } catch (_) {}

        // Окно выбора предполагаемых кабелей по участку (нижний центр)
        try {
            const host = this.map.getContainer?.();
            if (host) {
                const el = document.createElement('div');
                el.id = 'assumed-segment-picker';
                el.className = 'assumed-segment-picker hidden';
                host.appendChild(el);
                this.assumedSegmentPickerEl = el;
                try {
                    if (typeof L !== 'undefined' && L?.DomEvent) {
                        L.DomEvent.disableScrollPropagation(el);
                        L.DomEvent.disableClickPropagation(el);
                    }
                } catch (_) {}
            }
        } catch (_) {}

        // Отслеживание координат курсора
        this.map.on('mousemove', (e) => {
            this.updateCursorCoordinates(e);
            try {
                if (this.rulerMode) this.updateRulerMouseMove(e.latlng);
            } catch (_) {}
            this.updateHoverSnap(e.latlng);
        });

        // Клик по карте
        this.map.on('click', (e) => this.onMapClick(e));

        // Правая кнопка мыши: линейка -> удалить последнюю точку
        try {
            const host = this.map.getContainer?.();
            if (host) {
                host.addEventListener('contextmenu', (e) => {
                    try {
                        if (!this.rulerMode) return;
                        const pts = this.rulerPoints || [];
                        if (!pts.length) return;
                        e.preventDefault();
                        e.stopPropagation();
                        this.removeLastRulerPoint?.();
                    } catch (_) {}
                });
            }
        } catch (_) {}

        // Ctrl + drag: прямоугольное выделение (мультивыбор)
        try { this.initBoxSelection(); } catch (_) {}

        // Авто-скрытие подписей колодцев по зуму + пересборка подписей направлений (угол зависит от зума)
        this.map.on('zoomend', () => {
            this.updateWellLabelsVisibility();
            this.updateObjectCoordinatesLabelsVisibility();
            if (this.directionLengthLabelsEnabled) this.rebuildDirectionLengthLabelsFromDirectionsLayer();
        });
        this.updateWellLabelsVisibility();
        this.updateObjectCoordinatesLabelsVisibility();

        console.log('Карта инициализирована');
    },

    async loadInventoryLayer() {
        try {
            const resp = await API.inventory.geojson(this.filters || {});
            if (resp?.success === false) return;
            if (!resp?.type || resp.type !== 'FeatureCollection') return;

            const maxInv = Number(resp?.properties?.max_inv_cables ?? 0) || 0;
            const features = Array.isArray(resp.features) ? resp.features : [];

            this.layers.inventory.clearLayers();
            if (this.inventoryLabelsLayer) this.inventoryLabelsLayer.clearLayers();

            const lerp = (a, b, t) => Math.round(a + (b - a) * t);
            const toHex = (v) => v.toString(16).padStart(2, '0');
            const rgb = (r, g, b) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            const colorForUnaccounted = (u) => {
                const n0 = Number(u);
                const n = Number.isFinite(n0) ? Math.trunc(n0) : null;
                if (n === null) return '#777777';
                if (n < 0) return '#0098ff';
                if (n === 0) return '#01b73f';
                if (n === 1) return '#f9adad';
                // Градиент от #f9adad (1) до #ff0000 (maxInv)
                const start = [0xF9, 0xAD, 0xAD];
                const end = [0xFF, 0x00, 0x00];
                const max = Math.max(1, Math.trunc(maxInv || 0));
                if (max <= 1) return '#ff0000';
                const t = Math.max(0, Math.min(1, (n - 1) / (max - 1)));
                return rgb(
                    lerp(start[0], end[0], t),
                    lerp(start[1], end[1], t),
                    lerp(start[2], end[2], t),
                );
            };

            const buildInvLabel = (latlng, text, angleDeg) => {
                const a = Number(angleDeg || 0) || 0;
                const html = `<div style="transform: translate(-50%, -50%) rotate(${a}deg); transform-origin:center;">
                    <div style="background: rgba(255,255,255,0.85); color:#111; padding:2px 6px; border-radius:6px; border:1px solid rgba(0,0,0,0.25); font-size:12px; font-weight:600; white-space:nowrap;">
                        ${text}
                    </div>
                </div>`;
                return L.marker(latlng, {
                    icon: L.divIcon({ className: 'inv-unacc-label', html, iconSize: null }),
                    interactive: false,
                    pane: 'inventoryLabelPane',
                });
            };

            // Рендерим линии
            L.geoJSON({ type: 'FeatureCollection', features }, {
                pane: 'inventoryPane',
                style: (feature) => {
                    const p = feature?.properties || {};
                    const u = p.inv_unaccounted;
                    const hasInv = (p.inv_unaccounted !== null && p.inv_unaccounted !== undefined);
                    const color = hasInv ? colorForUnaccounted(u) : '#777777';
                    const weight = hasInv ? (this.getDirectionLineWeight() * 2) : this.getDirectionLineWeight();
                    return { color, weight, opacity: 0.85 };
                },
                onEachFeature: (feature, layer) => {
                    const p = feature?.properties || {};
                    const dirId = parseInt(p.id || 0, 10);
                    layer._igsMeta = { objectType: 'channel_direction', properties: p };
                    try {
                        // Интерактивность: hover popup со списком кабелей (для всех направлений)
                        if (dirId) {
                            layer.on('mouseover', async (e) => {
                                try {
                                    const cached = this._inventoryCablesPopupCache.get(dirId);
                                    if (cached) {
                                        layer.bindPopup(cached, { maxWidth: 360 });
                                        layer.openPopup(e.latlng);
                                        return;
                                    }
                                    const r = await API.unifiedCables.byDirection(dirId);
                                    const list = r?.data || r || [];
                                    const html = (Array.isArray(list) && list.length)
                                        ? `<div style="max-height:200px; overflow:auto;">${list.map(c => `<div style="margin-bottom:4px;">${String(c.number || c.id || '')}</div>`).join('')}</div>`
                                        : '<div class="text-muted">Кабели не найдены</div>';
                                    this._inventoryCablesPopupCache.set(dirId, html);
                                    layer.bindPopup(html, { maxWidth: 360 });
                                    layer.openPopup(e.latlng);
                                } catch (_) {}
                            });
                            layer.on('mouseout', () => {
                                try { layer.closePopup(); } catch (_) {}
                            });
                        }
                    } catch (_) {}

                    // Подпись "неучтенных"
                    try {
                        const hasInv = (p.inv_unaccounted !== null && p.inv_unaccounted !== undefined);
                        if (hasInv && this.inventoryUnaccountedLabelsEnabled) {
                            const latlngs = layer.getLatLngs?.();
                            const g = this._polylineMidpointAndAngle(latlngs);
                            if (g?.mid && this.inventoryLabelsLayer) {
                                buildInvLabel(g.mid, String(p.inv_unaccounted), g.angle).addTo(this.inventoryLabelsLayer);
                            }
                        }
                    } catch (_) {}
                },
            }).addTo(this.layers.inventory);
        } catch (_) {
            // ignore
        }
    },

    setInventoryUnaccountedLabelsEnabled(enabled) {
        this.inventoryUnaccountedLabelsEnabled = !!enabled;
        try {
            if (!this.map || !this.inventoryLabelsLayer) return;
            const invOn = !!(this.layers?.inventory && this.map.hasLayer(this.layers.inventory));
            if (!invOn) {
                this.inventoryLabelsLayer.clearLayers();
                return;
            }
            const has = this.map.hasLayer(this.inventoryLabelsLayer);
            if (this.inventoryUnaccountedLabelsEnabled && !has) {
                this.map.addLayer(this.inventoryLabelsLayer);
                // пересоберём подписи
                this.loadInventoryLayer?.();
            }
            if (!this.inventoryUnaccountedLabelsEnabled && has) {
                this.inventoryLabelsLayer.clearLayers();
                this.map.removeLayer(this.inventoryLabelsLayer);
            }
        } catch (_) {}
    },

    toggleInventoryUnaccountedLabels() {
        this.setInventoryUnaccountedLabelsEnabled(!this.inventoryUnaccountedLabelsEnabled);
    },

    toggleInventoryMode() {
        this.inventoryMode = !this.inventoryMode;
        if (this.inventoryMode) {
            // выключаем конфликтующие режимы
            try { this.cancelAddDirectionMode?.(); } catch (_) {}
            try { this.cancelAddingObject?.(); } catch (_) {}
            try { this.cancelAddCableMode?.({ notify: false }); } catch (_) {}
            try { this.cancelAddDuctCableMode?.({ notify: false }); } catch (_) {}
            try {
                if (this.shortestDuctCableMode) this.toggleShortestDuctCableMode?.();
            } catch (_) {}

            this.inventoryWell = null;
            this.inventoryDirectionCounts = {};
            try { this.inventoryInputLayer?.clearLayers?.(); } catch (_) {}

            if (this.map) this.map.getContainer().style.cursor = 'crosshair';
            const statusEl = document.getElementById('add-mode-status');
            const textEl = document.getElementById('add-mode-text');
            const finishBtn = document.getElementById('btn-finish-add-mode');
            if (statusEl) statusEl.classList.remove('hidden');
            if (finishBtn) finishBtn.classList.remove('hidden');
            if (textEl) textEl.textContent = 'Инвентаризация: выберите колодец, заполните значения на направлениях. Нажмите Enter или «Создать»';

            App.notify('Режим инвентаризации включён: выберите колодец', 'info');
        } else {
            this.cancelInventoryMode();
        }
    },

    // ========================
    // Геометрия: центр линии + угол (для подписей)
    // ========================
    _polylineMidpointAndAngle(latlngs) {
        try {
            if (!this.map || !latlngs) return null;
            // Нормализация в массив линий
            const lines = Array.isArray(latlngs) && Array.isArray(latlngs[0]) ? latlngs : [latlngs];
            if (!lines.length) return null;

            // выбираем самую "длинную" линию
            const lenOf = (arr) => {
                let sum = 0;
                for (let i = 1; i < (arr || []).length; i++) {
                    try { sum += this.map.distance(arr[i - 1], arr[i]); } catch (_) {}
                }
                return sum;
            };
            let best = lines[0] || [];
            let bestLen = lenOf(best);
            for (const ln of lines) {
                const l = lenOf(ln || []);
                if (l > bestLen) { best = ln || []; bestLen = l; }
            }
            const pts = (best || []).filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
            if (pts.length < 2) return null;

            const total = lenOf(pts);
            const half = total / 2;
            let acc = 0;
            for (let i = 1; i < pts.length; i++) {
                const a = pts[i - 1];
                const b = pts[i];
                const seg = this.map.distance(a, b);
                if (acc + seg >= half) {
                    const t = seg > 0 ? ((half - acc) / seg) : 0.5;
                    const mid = L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
                    const p1 = this.map.latLngToLayerPoint(a);
                    const p2 = this.map.latLngToLayerPoint(b);
                    let angle = Math.atan2((p2.y - p1.y), (p2.x - p1.x)) * 180 / Math.PI;
                    // нормализация, чтобы текст читался слева направо (как в подсказках длины)
                    if (angle > 90 || angle < -90) angle += 180;
                    return { mid, angle };
                }
                acc += seg;
            }
            // fallback: середина по индексу
            const mid = pts[Math.floor(pts.length / 2)];
            const a = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
            const b = pts[Math.min(pts.length - 1, Math.floor(pts.length / 2) + 1)];
            const p1 = this.map.latLngToLayerPoint(a);
            const p2 = this.map.latLngToLayerPoint(b);
            let angle = Math.atan2((p2.y - p1.y), (p2.x - p1.x)) * 180 / Math.PI;
            if (angle > 90 || angle < -90) angle += 180;
            return { mid, angle };
        } catch (_) {
            return null;
        }
    },

    cancelInventoryMode() {
        if (!this.inventoryMode) return;
        this.inventoryMode = false;
        this.inventoryWell = null;
        this.inventoryDirectionCounts = {};
        try { this.inventoryInputLayer?.clearLayers?.(); } catch (_) {}
        if (this.map) this.map.getContainer().style.cursor = '';
        // если не активны другие режимы — прячем add-mode-status
        try {
            const any = !!this.addDirectionMode || !!this.addCableMode || !!this.addDuctCableMode || !!this.addingObject;
            if (!any) document.getElementById('add-mode-status')?.classList?.add('hidden');
        } catch (_) {}
        try { document.getElementById('btn-inventory-mode')?.classList?.remove('active'); } catch (_) {}
        App.notify('Режим инвентаризации выключен', 'info');
    },

    async _inventoryPickWell(wellProps) {
        try {
            const wid = parseInt(wellProps?.id || 0, 10);
            const num = (wellProps?.number || '').toString();
            if (!wid) return;
            this.inventoryWell = { id: wid, number: num };
            this.inventoryDirectionCounts = {};
            this.inventoryInputLayer?.clearLayers?.();

            App.notify(`Инвентаризация: ${num || wid}. Заполните направления и нажмите «Создать».`, 'info');

            const dirsResp = await API.inventory.wellDirections(wid);
            const dirs = dirsResp?.data || dirsResp || [];
            const dirIds = (dirs || []).map(d => parseInt(d.id || 0, 10)).filter(n => n > 0);
            if (!dirIds.length) {
                App.notify('У колодца нет направлений', 'warning');
                return;
            }

            // Подсветим направления и построим инпуты на их серединах
            const fc = await API.channelDirections.geojsonByIds(dirIds);
            if (!fc || fc.type !== 'FeatureCollection') return;

            // кэш метаданных
            try {
                (dirs || []).forEach(d => {
                    const did = parseInt(d.id || 0, 10);
                    if (did) this._inventoryDirectionsCache.set(did, d);
                });
            } catch (_) {}

            const inputMarkerFor = (directionId, latlng) => {
                const safeId = String(directionId);
                const html = `
                    <div style="transform: translate(-50%, -50%);">
                        <div style="background: rgba(255,255,255,0.85); padding:4px 6px; border-radius:8px; border:1px solid rgba(0,0,0,0.25); box-shadow: 0 2px 6px rgba(0,0,0,0.25);">
                            <input type="number" data-direction-id="${safeId}" min="0" max="100" value="0"
                                style="width: 66px; background: transparent; color:#111; border:1px solid rgba(0,0,0,0.25); border-radius:6px; padding:2px 6px;">
                        </div>
                    </div>
                `;
                const marker = L.marker(latlng, {
                    pane: 'inventoryInputPane',
                    zIndexOffset: 1000,
                    icon: L.divIcon({ className: 'inv-dir-input', html, iconSize: null }),
                    interactive: true,
                    keyboard: false,
                });
                marker.on('add', () => {
                    try {
                        const el = marker.getElement();
                        if (!el) return;
                        const inp = el.querySelector('input[data-direction-id]');
                        if (!inp) return;
                        L.DomEvent.disableClickPropagation(el);
                        L.DomEvent.disableScrollPropagation(el);
                        inp.addEventListener('click', (e) => { try { e.stopPropagation(); } catch (_) {} });
                        inp.addEventListener('wheel', (e) => { try { e.stopPropagation(); } catch (_) {} });
                        inp.addEventListener('input', () => {
                            let v = parseInt(inp.value || '0', 10);
                            if (!Number.isFinite(v) || Number.isNaN(v)) v = 0;
                            v = Math.max(0, Math.min(100, v));
                            inp.value = String(v);
                            this.inventoryDirectionCounts[directionId] = v;
                        });
                    } catch (_) {}
                });
                return marker;
            };

            // Создаём инпуты
            const tmp = L.geoJSON(fc, {
                onEachFeature: (feature, layer) => {
                    try {
                        const p = feature?.properties || {};
                        const did = parseInt(p.id || 0, 10);
                        if (!did) return;
                        const latlngs = layer.getLatLngs?.();
                        const g = this._polylineMidpointAndAngle(latlngs);
                        if (!g?.mid) return;
                        inputMarkerFor(did, g.mid).addTo(this.inventoryInputLayer);
                        this.inventoryDirectionCounts[did] = 0;
                    } catch (_) {}
                },
            });
            try { tmp.remove?.(); } catch (_) {}
        } catch (_) {}
    },

    finishAddCableMode() {
        // Инвентаризация: открыть форму создания карточки с введёнными значениями
        if (this.inventoryMode) {
            if (!this.inventoryWell?.id) {
                App.notify('Выберите колодец', 'warning');
                return;
            }
            const counts = { ...(this.inventoryDirectionCounts || {}) };
            App.showAddInventoryCardModal?.(this.inventoryWell.id, { directionCounts: counts });
            return;
        }

        // Если активен режим duct — создаём duct кабель
        if (this.addDuctCableMode) {
            if (this.selectedDuctCableChannels.length < 1) {
                App.notify('Выберите минимум 1 канал', 'warning');
                return;
            }
            const selected = [...this.selectedDuctCableChannels];
            this.cancelAddDuctCableMode({ notify: false });
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

        this.cancelAddCableMode({ notify: false });

        App.showAddCableModalFromMap(typeCode, coords);
    },

    initBoxSelection() {
        if (!this.map) return;
        if (this._boxSelBound) return;
        this._boxSelBound = true;

        const container = this.map.getContainer();
        const state = {
            primed: false,
            moved: false,
            startPt: null,
            startLatLng: null,
            rect: null,
        };

        const isBlockedByMode = () => {
            return !!(
                this.groupPickMode ||
                this.incidentSelectMode ||
                this.addDirectionMode ||
                this.addingObject ||
                this.addCableMode ||
                this.addDuctCableMode ||
                this.relocateDuctCableMode ||
                this.shortestDuctCableMode ||
                this.movePointMode ||
                this.stuffWellMode
            );
        };

        const onMove = (ev) => {
            if (!state.primed || !this.map) return;
            const pt = L.point(ev.clientX, ev.clientY);
            const d = state.startPt ? pt.distanceTo(state.startPt) : 0;
            const threshold = 8;
            if (!state.moved && d < threshold) return;

            if (!state.moved) {
                state.moved = true;
                // выключаем drag карты на время выделения
                try { this.map.dragging.disable(); } catch (_) {}
                try { container.style.cursor = 'crosshair'; } catch (_) {}
            }

            const curLatLng = this.map.mouseEventToLatLng(ev);
            const b = L.latLngBounds(state.startLatLng, curLatLng);
            if (!state.rect) {
                state.rect = L.rectangle(b, {
                    interactive: false,
                    color: '#3b82f6',
                    weight: 2,
                    opacity: 0.9,
                    fillColor: '#3b82f6',
                    fillOpacity: 0.12,
                    dashArray: '4,4',
                }).addTo(this.map);
            } else {
                state.rect.setBounds(b);
            }
        };

        const onUp = (ev) => {
            if (!state.primed) return;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            state.primed = false;

            // если drag не начался — это обычный Ctrl+клик, пусть обработает click-хендлер Leaflet
            if (!state.moved) return;

            try { ev.preventDefault(); } catch (_) {}
            try { ev.stopPropagation(); } catch (_) {}

            // возвращаем drag карты
            try { this.map.dragging.enable(); } catch (_) {}
            try { container.style.cursor = ''; } catch (_) {}

            let bounds = null;
            try { bounds = state.rect?.getBounds?.(); } catch (_) {}
            try { if (state.rect) this.map.removeLayer(state.rect); } catch (_) {}
            state.rect = null;
            state.moved = false;

            if (!bounds || !bounds.isValid?.() || !bounds.isValid()) return;
            // подавляем "клик" после drag-выделения (иногда Leaflet может его сгенерировать)
            try {
                this._suppressClickOnce = true;
                setTimeout(() => { this._suppressClickOnce = false; }, 150);
            } catch (_) {}
            this.addObjectsFullyInsideBoundsToMultiSelection(bounds);
        };

        const onDown = (ev) => {
            try {
                if (!this.map) return;
                if (isBlockedByMode()) return;
                if (ev.button !== 0) return;
                const isCtrl = !!(ev.ctrlKey || ev.metaKey);
                if (!isCtrl) return;

                state.primed = true;
                state.moved = false;
                state.startPt = L.point(ev.clientX, ev.clientY);
                state.startLatLng = this.map.mouseEventToLatLng(ev);
                if (state.rect) {
                    try { this.map.removeLayer(state.rect); } catch (_) {}
                    state.rect = null;
                }

                document.addEventListener('mousemove', onMove, true);
                document.addEventListener('mouseup', onUp, true);
            } catch (_) {}
        };

        // Важно: слушаем DOM, чтобы отличать drag от click
        container.addEventListener('mousedown', onDown, true);
    },

    addObjectsFullyInsideBoundsToMultiSelection(bounds) {
        if (!bounds || !this.layers) return;

        const hits = [];

        const layerFullyInside = (layer) => {
            if (!layer || !bounds) return false;
            // Point-like
            if (typeof layer.getLatLng === 'function') {
                const ll = layer.getLatLng();
                return !!(ll && bounds.contains(ll));
            }
            // Polyline-like
            if (typeof layer.getLatLngs === 'function') {
                const latlngs = layer.getLatLngs().flat(Infinity).filter(ll => ll && ll.lat !== undefined);
                if (!latlngs.length) return false;
                return latlngs.every(ll => bounds.contains(ll));
            }
            return false;
        };

        const traverse = (layer) => {
            if (!layer) return;
            if (typeof layer.getLayers === 'function') {
                layer.getLayers().forEach(traverse);
                return;
            }
            const meta = layer?._igsMeta;
            if (!meta || !meta.objectType || !meta.properties?.id) return;
            if (!layerFullyInside(layer)) return;
            hits.push({
                objectType: meta.objectType,
                properties: meta.properties,
            });
        };

        Object.values(this.layers || {}).forEach(group => traverse(group));

        if (!hits.length) {
            try { App.notify('В прямоугольнике нет объектов', 'info'); } catch (_) {}
            return;
        }

        if (!(this.multiSelected instanceof Map)) this.multiSelected = new Map();
        // При первом box-select — снимаем одиночное выделение
        this.clearSelectedObject();

        let added = 0;
        for (const h of hits) {
            const key = this.multiSelectKey(h);
            if (this.multiSelected.has(key)) continue;
            this.multiSelected.set(key, { objectType: h.objectType, properties: h.properties });
            const layer = this.findLayerByMeta(h.objectType, h.properties.id);
            if (layer) this.applySelectedShadow(layer, true);
            added += 1;
        }

        if ((this.multiSelected?.size || 0) === 0) {
            this.hideMultiSelectionInfo();
            return;
        }

        this.showMultiSelectionInfo();
        try { App.notify(`Выбрано объектов: ${this.multiSelected.size}`, 'success'); } catch (_) {}
    },

    setMapDefaultsEnabled(enabled) {
        this.mapDefaultsEnabled = !!enabled;
        const el = this.mapDefaultsEl || document.getElementById('map-defaults');
        if (!el) return;
        if (!this.mapDefaultsEnabled) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }
        el.classList.remove('hidden');
        // позиционируем под панелью инструментов карты (чтобы не пересекалось с легендой собственников)
        try { this.positionMapDefaultsPanel(); } catch (_) {}
        // отрисовка в App (чтобы переиспользовать API/настройки)
        try { App?.renderMapDefaultsPanel?.(el); } catch (_) {}
    },

    toggleMapDefaults() {
        this.setMapDefaultsEnabled(!this.mapDefaultsEnabled);
    },

    positionMapDefaultsPanel() {
        const el = this.mapDefaultsEl || document.getElementById('map-defaults');
        const host = this.map?.getContainer?.();
        const toolbar = document.getElementById('map-toolbar');
        if (!el || !host || !toolbar) return;

        const hostRect = host.getBoundingClientRect();
        const tbRect = toolbar.getBoundingClientRect();

        const margin = 8;
        const top = Math.max(0, Math.round(tbRect.bottom - hostRect.top + margin));

        // Reset anchors
        el.style.bottom = 'auto';
        el.style.top = `${top}px`;
        el.style.left = '';
        el.style.right = '';

        // Align to toolbar side (left on desktop, right on mobile)
        const tbLeft = Math.round(tbRect.left - hostRect.left);
        const tbRight = Math.round(hostRect.right - tbRect.right);

        if (tbRight <= tbLeft) {
            // toolbar is closer to right edge
            el.style.right = `${Math.max(0, tbRight)}px`;
        } else {
            el.style.left = `${Math.max(0, tbLeft)}px`;
        }
    },

    startIncidentSelectMode() {
        this.incidentSelectMode = true;
        if (this.map) this.map.getContainer().style.cursor = 'crosshair';
        App.notify('Кликните на объекте на карте для привязки к инциденту', 'info');
    },

    startGroupPickMode(groupId) {
        this.groupPickMode = true;
        this.groupPickGroupId = parseInt(groupId);
        if (this.map) this.map.getContainer().style.cursor = 'crosshair';
        App.notify('Кликните на объекте на карте для добавления в группу', 'info');
    },

    /**
     * Загрузка всех данных
     */
    async loadAllLayers() {
        console.log('Загрузка слоёв карты...');

        // Если активен режим группы — слои загружаются через loadGroup()
        if (this.groupMode) return;

        // Сохраняем текущий вид карты (чтобы обновление слоёв не влияло на зум/центр)
        const curCenter = this.map ? this.map.getCenter() : null;
        const curZoom = this.map ? this.map.getZoom() : null;

        // Фильтр по контракту: показываем только колодцы + кабели (направления/столбики не показываем)
        const contractOnly = !!this.filters?.contract_id;
        if (contractOnly) {
            this.layers.channels.clearLayers();
            this.layers.markers.clearLayers();
        }
        
        const results = await Promise.allSettled([
            this.loadWells(),
            contractOnly ? Promise.resolve() : this.loadChannelDirections(),
            contractOnly ? Promise.resolve() : this.loadMarkerPosts(),
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
        
        // Не подгоняем автоматически (фиксированный стартовый зум/центр по ТЗ)
        try {
            if (this.map && curCenter && typeof curZoom === 'number') {
                this.map.setView(curCenter, curZoom, { animate: false });
            }
        } catch (_) {}

        // Если включён слой инвентаризации — обновляем его (без влияния на центр/зум)
        try {
            if (this.map && this.layers?.inventory && this.map.hasLayer(this.layers.inventory)) {
                await this.loadInventoryLayer?.();
            }
        } catch (_) {}

        // Если включён слой предполагаемых кабелей — обновляем его
        try {
            if (this.map && this.layers?.assumedCables && this.map.hasLayer(this.layers.assumedCables)) {
                await this.loadAssumedCablesLayer?.();
            }
        } catch (_) {}
    },

    /**
     * Обновить карту (перезагрузить слои), сохранив текущий центр/зум.
     * Требование: без изменения фокуса и зума.
     */
    async refreshMapPreserveView() {
        const curCenter = this.map ? this.map.getCenter() : null;
        const curZoom = this.map ? this.map.getZoom() : null;

        try {
            if (this.groupMode && this.activeGroupId) {
                await this.loadGroup(this.activeGroupId, this._lastGroupFilters || {});
            } else {
                await this.loadAllLayers();
            }
        } finally {
            try {
                if (this.map && curCenter && typeof curZoom === 'number') {
                    this.map.setView(curCenter, curZoom, { animate: false });
                }
            } catch (_) {}
            try {
                // Подстраховка: если изменился размер контейнера/DOM
                this.map?.invalidateSize?.({ pan: false, animate: false });
            } catch (_) {}
        }
    },

    /**
     * Загрузка колодцев
     */
    async loadWells() {
        try {
            // Фильтр по контракту: колодцы показываем ВСЕ (игнорируем остальные фильтры)
            const f = { ...(this.filters || {}) };
            if (f.contract_id) {
                // при выбранном контракте колодцы не фильтруем
                for (const k of Object.keys(f)) delete f[k];
            }

            console.log('Loading wells with filters:', f);
            const response = await API.wells.geojson(f);
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
            if (this.wellLabelsLayer) this.wellLabelsLayer.clearLayers();
            if (this.objectCoordinatesLabelsLayer) this.objectCoordinatesLabelsLayer.clearLayers();
            
            // Фильтруем features с невалидной геометрией
            const validFeatures = response.features.filter(f => f && f.geometry && f.geometry.type);
            console.log('Valid wells features:', validFeatures.length);
            
            if (validFeatures.length > 0) {
                L.geoJSON({ type: 'FeatureCollection', features: validFeatures }, {
                    pointToLayer: (feature, latlng) => {
                        // Цвет символа колодца — из справочника "Виды объектов" (object_types.well.color)
                        return this.createWellMarker(latlng, feature?.properties || {});
                    },
                    onEachFeature: (feature, layer) => {
                        const coords = layer.getLatLng();
                        layer._igsMeta = {
                            objectType: 'well',
                            properties: {
                                ...feature.properties,
                                _lat: coords?.lat,
                                _lng: coords?.lng,
                            }
                        };
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
                            L.DomEvent.stopPropagation(e);
                            this.handleObjectsClick(e);
                        });

                        // Popup при наведении
                        layer.bindTooltip(`
                            <strong>Колодец: ${feature.properties.number}</strong><br>
                            Тип: ${feature.properties.type_name || '-'}<br>
                            Статус: ${feature.properties.status_name || '-'}
                        `, { permanent: false, direction: 'top' });
                    },
                }).addTo(this.layers.wells);
                // Пересобираем подписи из текущего слоя колодцев (важно для режима "Группа")
                if (this.wellLabelsEnabled) this.rebuildWellLabelsFromWellsLayer();
                this.updateWellLabelsVisibility();
                if (this.objectCoordinatesLabelsEnabled) this.rebuildObjectCoordinatesLabelsFromPointLayers();
                this.updateObjectCoordinatesLabelsVisibility();
            }
        } catch (error) {
            console.error('Ошибка загрузки колодцев:', error);
        }
    },

    updateWellLabelsVisibility() {
        if (!this.map || !this.wellLabelsLayer) return;
        const wellsVisible = !!(this.layers?.wells && this.map.hasLayer(this.layers.wells));
        const shouldShow = wellsVisible && this.wellLabelsEnabled && this.map.getZoom() >= this.wellLabelsMinZoom;
        const hasLayer = this.map.hasLayer(this.wellLabelsLayer);
        if (shouldShow && !hasLayer) this.map.addLayer(this.wellLabelsLayer);
        if (!shouldShow && hasLayer) this.map.removeLayer(this.wellLabelsLayer);
    },

    updateObjectCoordinatesLabelsVisibility() {
        if (!this.map || !this.objectCoordinatesLabelsLayer) return;
        const wellsVisible = !!(this.layers?.wells && this.map.hasLayer(this.layers.wells));
        const shouldShow = wellsVisible && this.objectCoordinatesLabelsEnabled && this.map.getZoom() >= this.objectCoordinatesLabelsMinZoom;
        const hasLayer = this.map.hasLayer(this.objectCoordinatesLabelsLayer);
        if (shouldShow && !hasLayer) this.map.addLayer(this.objectCoordinatesLabelsLayer);
        if (!shouldShow && hasLayer) this.map.removeLayer(this.objectCoordinatesLabelsLayer);
    },

    setWellLabelsEnabled(enabled) {
        this.wellLabelsEnabled = !!enabled;
        if (this.wellLabelsEnabled) this.rebuildWellLabelsFromWellsLayer();
        this.updateWellLabelsVisibility();
    },

    toggleWellLabels() {
        this.setWellLabelsEnabled(!this.wellLabelsEnabled);
    },

    setObjectCoordinatesLabelsEnabled(enabled) {
        this.objectCoordinatesLabelsEnabled = !!enabled;
        if (this.objectCoordinatesLabelsEnabled) this.rebuildObjectCoordinatesLabelsFromPointLayers();
        this.updateObjectCoordinatesLabelsVisibility();
    },

    toggleObjectCoordinatesLabels() {
        this.setObjectCoordinatesLabelsEnabled(!this.objectCoordinatesLabelsEnabled);
    },

    rebuildDirectionLengthLabelsFromDirectionsLayer() {
        if (!this.map || !this.directionLengthLabelsLayer) return;
        this.directionLengthLabelsLayer.clearLayers();

        const fontSize = this.getDirectionLengthLabelFontSizePx();

        const traverse = (layer, cb) => {
            if (!layer) return;
            if (typeof layer.getLayers === 'function') {
                (layer.getLayers() || []).forEach(l => traverse(l, cb));
                return;
            }
            cb(layer);
        };

        const addLabelForLine = (lineLayer) => {
            const meta = lineLayer?._igsMeta;
            if (!meta || meta.objectType !== 'channel_direction') return;
            const props = meta.properties || {};
            const lenM = props.length_m;
            if (lenM === null || lenM === undefined || lenM === '') return;

            const latlngsRaw = lineLayer.getLatLngs?.();
            if (!latlngsRaw) return;
            const latlngs = Array.isArray(latlngsRaw[0]) ? latlngsRaw[0] : latlngsRaw;
            if (!Array.isArray(latlngs) || latlngs.length < 2) return;

            const pts = latlngs.map(ll => this.map.latLngToLayerPoint(ll));
            let total = 0;
            const segLens = [];
            for (let i = 0; i < pts.length - 1; i++) {
                const dx = pts[i + 1].x - pts[i].x;
                const dy = pts[i + 1].y - pts[i].y;
                const d = Math.sqrt(dx * dx + dy * dy);
                segLens.push(d);
                total += d;
            }
            if (!total) return;
            const half = total / 2;
            let acc = 0;
            let idx = 0;
            while (idx < segLens.length && acc + segLens[idx] < half) {
                acc += segLens[idx];
                idx++;
            }
            idx = Math.min(idx, segLens.length - 1);
            const segLen = segLens[idx] || 1;
            const t = (half - acc) / segLen;
            const p0 = pts[idx];
            const p1 = pts[idx + 1];

            const mx = p0.x + (p1.x - p0.x) * t;
            const my = p0.y + (p1.y - p0.y) * t;
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            let angle = Math.atan2(dy, dx) * 180 / Math.PI;
            if (angle > 90 || angle < -90) angle += 180;

            // Точка привязки подписи — строго в центре линии
            const pos = this.map.layerPointToLatLng(L.point(mx, my));

            const text = `${Number(lenM).toFixed(2)} м`;
            const icon = L.divIcon({
                className: 'direction-length-label',
                // Центрируем текст по точке, и уже затем поворачиваем вдоль линии
                html: `<div style="transform: translate(-50%, -50%) rotate(${angle}deg); transform-origin: center; white-space: nowrap; font-size:${fontSize}px; color:#111; background: rgba(255,255,255,0.85); border: 1px solid rgba(0,0,0,0.15); border-radius: 6px; padding: 2px 6px;">${text}</div>`,
                iconAnchor: [0, 0],
            });
            L.marker(pos, { icon, interactive: false, keyboard: false }).addTo(this.directionLengthLabelsLayer);
        };

        traverse(this.layers?.channels, addLabelForLine);
    },

    setDirectionLengthLabelsEnabled(enabled) {
        this.directionLengthLabelsEnabled = !!enabled;
        if (!this.map || !this.directionLengthLabelsLayer) return;
        const channelsVisible = !!(this.layers?.channels && this.map.hasLayer(this.layers.channels));
        const has = this.map.hasLayer(this.directionLengthLabelsLayer);
        if (this.directionLengthLabelsEnabled && channelsVisible && !has) this.map.addLayer(this.directionLengthLabelsLayer);
        if ((!this.directionLengthLabelsEnabled || !channelsVisible) && has) this.map.removeLayer(this.directionLengthLabelsLayer);
        if (this.directionLengthLabelsEnabled && channelsVisible) this.rebuildDirectionLengthLabelsFromDirectionsLayer();
        else this.directionLengthLabelsLayer.clearLayers();
    },

    toggleDirectionLengthLabels() {
        this.setDirectionLengthLabelsEnabled(!this.directionLengthLabelsEnabled);
    },

    async fetchOwnersLegendData() {
        try {
            if (this._ownersLegendCache && Array.isArray(this._ownersLegendCache)) return this._ownersLegendCache;
            if (typeof API === 'undefined') return [];
            const resp = await (API.owners?.colors ? API.owners.colors() : API.references.all('owners'));
            const rows = resp?.data || resp || [];
            const out = (rows || []).map(o => ({
                id: o.id,
                code: o.code,
                short_name: o.short_name || o.name || o.code || '',
                name: o.name || '',
                color: (o.color || '').toString().trim() || '#999999',
            }));
            out.sort((a, b) => String(a.short_name).localeCompare(String(b.short_name), 'ru'));
            this._ownersLegendCache = out;
            return out;
        } catch (_) {
            return [];
        }
    },

    async renderOwnersLegend() {
        const el = this.ownersLegendEl || document.getElementById('owners-legend');
        if (!el) return;
        if (!this.ownersLegendEnabled) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }
        const owners = await this.fetchOwnersLegendData();
        el.innerHTML = `
            <div class="owners-legend-title">Легенда по собственникам</div>
            <div class="owners-legend-list">
                ${(owners || []).map(o => `
                    <div class="owners-legend-item" title="${String(o.name || o.short_name || '').replace(/"/g, '&quot;')}">
                        <button type="button" class="owners-legend-swatch" data-owner-id="${o.id}" data-color="${o.color}" style="background:${o.color};" title="Изменить цвет"></button>
                        <span class="owners-legend-text">${String(o.short_name || o.code || '')}</span>
                    </div>
                `).join('')}
            </div>
        `;
        el.classList.remove('hidden');

        // Персональная смена цвета по клику на маркер
        try {
            el.querySelectorAll('.owners-legend-swatch[data-owner-id]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const ownerId = parseInt(btn.dataset.ownerId, 10);
                    if (!ownerId) return;
                    const current = (btn.dataset.color || '#3b82f6').toString();

                    const input = document.createElement('input');
                    input.type = 'color';
                    input.value = current;
                    input.style.position = 'absolute';
                    input.style.left = '-9999px';
                    document.body.appendChild(input);

                    const cleanup = () => { try { document.body.removeChild(input); } catch (_) {} };

                    input.addEventListener('change', async () => {
                        const color = (input.value || '').toString();
                        cleanup();
                        try {
                            const resp = await API.owners.setColor(ownerId, color);
                            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');

                            // Сбрасываем кеш и перерисовываем
                            this._ownersLegendCache = null;
                            await this.renderOwnersLegend();
                            await this.reloadForLegend();
                        } catch (e) {
                            App?.notify?.(e?.message || 'Не удалось сохранить цвет', 'error');
                        }
                    }, { once: true });

                    input.addEventListener('blur', cleanup, { once: true });
                    input.click();
                });
            });
        } catch (_) {}
    },

    async reloadForLegend() {
        if (this.groupMode && this.activeGroupId) {
            await this.loadGroup(this.activeGroupId, this._lastGroupFilters || {});
            return;
        }
        await this.loadAllLayers();
    },

    async setOwnersLegendEnabled(enabled) {
        this.ownersLegendEnabled = !!enabled;
        await this.renderOwnersLegend();
        await this.reloadForLegend();
    },

    toggleOwnersLegend() {
        this.setOwnersLegendEnabled(!this.ownersLegendEnabled);
    },

    // ========================
    // Линейка (измерение)
    // ========================

    toggleRulerMode() {
        if (this.rulerMode) this.cancelRulerMode();
        else this.startRulerMode();
    },

    startRulerMode() {
        if (!this.map) return;
        this.rulerMode = true;
        this.rulerSumMeters = 0;
        this.rulerPoints = [];
        this.rulerFixedSegments = [];
        this.rulerLastCursorLatLng = null;

        // выключаем конфликтующие режимы (best-effort)
        try {
            this.cancelAddDirectionMode?.();
            this.cancelAddingObject?.();
            this.cancelAddCableMode?.({ notify: false });
            this.cancelAddDuctCableMode?.({ notify: false });
            if (this.movePointMode) this.cancelMovePointMode?.();
            if (this.relocateDuctCableMode) this.toggleRelocateDuctCableMode?.();
            if (this.shortestDuctCableMode) this.toggleShortestDuctCableMode?.();
            if (this.inventoryMode) this.cancelInventoryMode?.();
            if (this.stuffWellMode) this.toggleStuffWellMode?.();
        } catch (_) {}

        this.map.getContainer().style.cursor = 'crosshair';

        // слой линейки
        try {
            if (this.rulerLayer) {
                this.rulerLayer.clearLayers();
                this.map.removeLayer(this.rulerLayer);
            }
        } catch (_) {}
        this.rulerLayer = L.featureGroup().addTo(this.map);

        // статус + отмена (используем общий add-mode-status)
        try {
            const statusEl = document.getElementById('add-mode-status');
            const textEl = document.getElementById('add-mode-text');
            const finishBtn = document.getElementById('btn-finish-add-mode');
            if (statusEl) statusEl.classList.remove('hidden');
            if (finishBtn) finishBtn.classList.add('hidden');
            if (textEl) textEl.textContent = 'Линейка: кликните точки. Esc или «Отмена» — выход.';
        } catch (_) {}

        try { App?.notify?.('Линейка включена', 'info'); } catch (_) {}
    },

    cancelRulerMode(opts = null) {
        if (!this.rulerMode) return;
        this.rulerMode = false;
        this.rulerLastCursorLatLng = null;
        this.rulerSumMeters = 0;
        this.rulerPoints = [];
        this.rulerFixedSegments = [];

        try {
            if (this.rulerLayer) {
                this.rulerLayer.clearLayers();
                this.map.removeLayer(this.rulerLayer);
            }
        } catch (_) {}
        this.rulerLayer = null;
        this.rulerTempLine = null;
        this.rulerCursorLabel = null;

        // курсор возвращаем, если не активны другие режимы
        try {
            const anyCrosshair = !!(this.addDirectionMode || this.addingObject || this.addCableMode || this.addDuctCableMode || this.groupPickMode || this.incidentSelectMode || this.inventoryMode || this.movePointMode);
            if (!anyCrosshair && this.map) this.map.getContainer().style.cursor = '';
        } catch (_) {}

        // прячем статус, если не активны другие режимы добавления
        try {
            if (!this.addDirectionMode && !this.addingObject && !this.addCableMode && !this.addDuctCableMode) {
                document.getElementById('add-mode-status')?.classList?.add('hidden');
            }
        } catch (_) {}

        try {
            const o = opts || {};
            if (o.notify !== false) App?.notify?.('Линейка выключена', 'info');
        } catch (_) {}
    },

    formatRulerDistance(meters) {
        const m = Number(meters);
        if (!Number.isFinite(m)) return '-';
        if (m >= 1000) return `${(m / 1000).toFixed(3)} км`;
        return `${m.toFixed(2)} м`;
    },

    formatRulerCoords(latlng) {
        const lat = Number(latlng?.lat);
        const lng = Number(latlng?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return ['-', '-'];
        return [lat.toFixed(6), lng.toFixed(6)];
    },

    rulerMidpointAndAngle(latlngA, latlngB) {
        try {
            const p0 = this.map.latLngToLayerPoint(latlngA);
            const p1 = this.map.latLngToLayerPoint(latlngB);
            const mx = (p0.x + p1.x) / 2;
            const my = (p0.y + p1.y) / 2;
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            let angle = Math.atan2(dy, dx) * 180 / Math.PI;
            if (angle > 90 || angle < -90) angle += 180;
            const pos = this.map.layerPointToLatLng(L.point(mx, my));
            return { pos, angle };
        } catch (_) {
            return { pos: latlngA, angle: 0 };
        }
    },

    ensureRulerCursorLabel(latlng, html) {
        try {
            const icon = L.divIcon({
                className: 'ruler-div-icon ruler-cursor-label',
                html: `<div style="transform: translate(-50%, -110%);">
                    <div style="background: rgba(255,255,255,0.9); color:#111; padding:2px 6px; border-radius:6px; border:1px solid rgba(0,0,0,0.2); font-size:12px; font-weight:700; white-space:nowrap; text-align:center;">
                        ${html}
                    </div>
                </div>`,
                iconAnchor: [0, 0],
                iconSize: null,
            });
            if (!this.rulerCursorLabel) {
                this.rulerCursorLabel = L.marker(latlng, { icon, interactive: false, keyboard: false, pane: 'rulerLabelPane' });
                this.rulerCursorLabel.addTo(this.rulerLayer);
            } else {
                this.rulerCursorLabel.setLatLng(latlng);
                this.rulerCursorLabel.setIcon(icon);
            }
        } catch (_) {}
    },

    updateRulerMouseMove(latlng) {
        if (!this.rulerMode || !this.map || !this.rulerLayer) return;
        this.rulerLastCursorLatLng = latlng;
        const pts = this.rulerPoints || [];
        if (!pts.length) {
            // нет точек — не показываем ничего
            try {
                if (this.rulerTempLine) this.rulerLayer.removeLayer(this.rulerTempLine);
                this.rulerTempLine = null;
                if (this.rulerCursorLabel) this.rulerLayer.removeLayer(this.rulerCursorLabel);
                this.rulerCursorLabel = null;
            } catch (_) {}
            return;
        }

        const last = pts[pts.length - 1]?.latlng;
        if (last) {
            // временная линия до курсора
            if (!this.rulerTempLine) {
                this.rulerTempLine = L.polyline([last, latlng], {
                    color: '#555555',
                    weight: 2,
                    opacity: 0.9,
                    dashArray: '6, 6',
                    pane: 'rulerLinePane',
                    interactive: false,
                }).addTo(this.rulerLayer);
            } else {
                this.rulerTempLine.setLatLngs([last, latlng]);
            }
        }

        const tailMeters = last ? this.map.distance(last, latlng) : 0;
        const sumBuilt = Number(this.rulerSumMeters || 0) || 0;
        if (pts.length === 1) {
            this.ensureRulerCursorLabel(latlng, this.formatRulerDistance(tailMeters));
        } else {
            const total = sumBuilt + tailMeters;
            this.ensureRulerCursorLabel(
                latlng,
                `${this.formatRulerDistance(total)}<br><span style="font-weight:800; color:#ef4444;">${this.formatRulerDistance(sumBuilt)}</span>`
            );
        }
    },

    removeLastRulerPoint() {
        if (!this.rulerMode || !this.map || !this.rulerLayer) return;
        const pts = this.rulerPoints || [];
        if (!pts.length) return;

        // remove last point + coords label
        const last = pts.pop();
        try { if (last?.point) this.rulerLayer.removeLayer(last.point); } catch (_) {}
        try { if (last?.label) this.rulerLayer.removeLayer(last.label); } catch (_) {}
        this.rulerPoints = pts;

        // remove last fixed segment (if any)
        const segs = this.rulerFixedSegments || [];
        if (segs.length) {
            const seg = segs.pop();
            try { if (seg?.line) this.rulerLayer.removeLayer(seg.line); } catch (_) {}
            try { if (seg?.label) this.rulerLayer.removeLayer(seg.label); } catch (_) {}
            const m = Number(seg?.meters || 0) || 0;
            this.rulerSumMeters = Math.max(0, (Number(this.rulerSumMeters || 0) || 0) - m);
        }
        this.rulerFixedSegments = segs;

        // refresh cursor dynamic
        try {
            if (this.rulerLastCursorLatLng) this.updateRulerMouseMove(this.rulerLastCursorLatLng);
            else if (!this.rulerPoints.length) {
                // no points -> clear temp artifacts
                try {
                    if (this.rulerTempLine) this.rulerLayer.removeLayer(this.rulerTempLine);
                    this.rulerTempLine = null;
                    if (this.rulerCursorLabel) this.rulerLayer.removeLayer(this.rulerCursorLabel);
                    this.rulerCursorLabel = null;
                } catch (_) {}
            }
        } catch (_) {}
    },

    addRulerPoint(latlng) {
        if (!this.rulerMode || !this.map) return;
        if (!latlng) return;
        if (!this.rulerLayer) {
            this.rulerLayer = L.featureGroup().addTo(this.map);
        }

        const size = this.getWellMarkerSizePx(); // диаметр, px
        const radius = Math.max(2, Math.round(size / 4)); // в 2 раза меньше маркера

        const point = L.circleMarker(latlng, {
            radius,
            color: '#444444',
            weight: 1,
            opacity: 1,
            fillColor: '#555555',
            fillOpacity: 0.95,
            pane: 'rulerLinePane',
            interactive: false,
        }).addTo(this.rulerLayer);

        const [lat, lng] = this.formatRulerCoords(latlng);
        const coordIcon = L.divIcon({
            className: 'ruler-div-icon ruler-point-coords',
            html: `<div style="transform: translate(8px, -8px);">
                <div style="background: rgba(255,255,255,0.85); color:#111; padding:2px 6px; border-radius:6px; border:1px solid rgba(0,0,0,0.15); font-size:11px; font-weight:700; white-space:nowrap;">
                    ${lat}<br>${lng}
                </div>
            </div>`,
            iconAnchor: [0, 0],
            iconSize: null,
        });
        const label = L.marker(latlng, { icon: coordIcon, interactive: false, keyboard: false, pane: 'rulerLabelPane' }).addTo(this.rulerLayer);

        const prev = (this.rulerPoints || []).length ? this.rulerPoints[this.rulerPoints.length - 1].latlng : null;
        this.rulerPoints.push({ latlng, point, label });

        if (prev) {
            const meters = this.map.distance(prev, latlng);
            this.rulerSumMeters = (Number(this.rulerSumMeters || 0) || 0) + meters;

            const line = L.polyline([prev, latlng], {
                color: '#555555',
                weight: 2,
                opacity: 0.9,
                dashArray: '6, 6',
                pane: 'rulerLinePane',
                interactive: false,
            }).addTo(this.rulerLayer);

            const { pos, angle } = this.rulerMidpointAndAngle(prev, latlng);
            const distText = this.formatRulerDistance(meters);
            const segIcon = L.divIcon({
                className: 'ruler-div-icon ruler-seg-label',
                html: `<div style="transform: translate(-50%, -50%) rotate(${angle}deg); transform-origin:center;">
                    <div style="background: rgba(255,255,255,0.85); color:#111; padding:2px 6px; border-radius:6px; border:1px solid rgba(0,0,0,0.15); font-size:12px; font-weight:800; white-space:nowrap;">
                        ${distText}
                    </div>
                </div>`,
                iconAnchor: [0, 0],
                iconSize: null,
            });
            const segLabel = L.marker(pos, { icon: segIcon, interactive: false, keyboard: false, pane: 'rulerLabelPane' }).addTo(this.rulerLayer);
            this.rulerFixedSegments.push({ line, label: segLabel, meters });
        }

        // обновим динамику на курсоре (если курсор уже известен)
        try {
            if (this.rulerLastCursorLatLng) this.updateRulerMouseMove(this.rulerLastCursorLatLng);
        } catch (_) {}
    },

    async loadAssumedCablesLayer(variantNo = null) {
        try {
            const v0 = (variantNo === null || variantNo === undefined)
                ? (this.assumedCablesVariantNo || 1)
                : variantNo;
            const v = [1, 2, 3].includes(Number(v0)) ? Number(v0) : 1;
            this.assumedCablesVariantNo = v;

            const resp = await API.assumedCables.geojson(v);
            if (resp?.success === false) return;
            if (!resp?.type || resp.type !== 'FeatureCollection' || !Array.isArray(resp.features)) return;

            this.layers.assumedCables?.clearLayers?.();
            try { this._assumedRouteLayerById = new Map(); } catch (_) {}
            try { this._assumedRoutesById = new Map(); } catch (_) {}
            try { this._assumedRouteIdsByDirectionId = new Map(); } catch (_) {}
            try { this._assumedBaseDirLatLngsById = new Map(); } catch (_) {}
            this._assumedRoutesPopupHtml = null;
            const features = resp.features.filter(f => f && f.geometry && f.geometry.type);
            // базовая сетка направлений (всегда серым, тоньше)
            try {
                // для hover-логики нужна полная геометрия направлений (без фильтров)
                const cd = await API.channelDirections.geojson({});
                if (cd && cd.type === 'FeatureCollection' && Array.isArray(cd.features)) {
                    const weight = Math.max(0.5, this.getDirectionLineWeight() / 2);
                    L.geoJSON(cd, {
                        pane: 'assumedCablesBasePane',
                        interactive: false,
                        style: () => ({ color: '#777777', weight, opacity: 0.75 }),
                        onEachFeature: (feature, layer) => {
                            try {
                                const p = feature?.properties || {};
                                const id = parseInt(p.id || p.direction_id || p.object_id || 0, 10);
                                if (!id) return;
                                const raw = layer.getLatLngs?.();
                                if (!raw) return;
                                const latlngs = Array.isArray(raw?.[0]) ? raw.flat(2) : raw;
                                if (Array.isArray(latlngs) && latlngs.length >= 2) {
                                    this._assumedBaseDirLatLngsById.set(id, latlngs);
                                }
                            } catch (_) {}
                        },
                    }).addTo(this.layers.assumedCables);
                }
            } catch (_) {}

            if (!features.length) return;

            const routeColor = '#8300ff';
            const routeOpacity = 0.1;
            const baseWeight = Math.max(1, this.getDirectionLineWeight());
            const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const fmt = (n) => {
                const x = Number(n);
                if (!Number.isFinite(x)) return '-';
                return (Math.round(x * 100) / 100).toFixed(2);
            };
            const normDirectionIds = (raw) => {
                try {
                    if (Array.isArray(raw)) return raw.map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
                    if (raw === null || raw === undefined) return [];
                    if (typeof raw === 'string') {
                        const s = raw.trim();
                        if (!s) return [];
                        const parsed = JSON.parse(s);
                        if (Array.isArray(parsed)) return parsed.map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
                    }
                } catch (_) {}
                return [];
            };
            const distSqPointToSegment = (p, a, b) => {
                const abx = b.x - a.x;
                const aby = b.y - a.y;
                const apx = p.x - a.x;
                const apy = p.y - a.y;
                const abLenSq = (abx * abx) + (aby * aby);
                if (abLenSq <= 0) return (apx * apx) + (apy * apy);
                let t = ((apx * abx) + (apy * aby)) / abLenSq;
                if (t < 0) t = 0;
                if (t > 1) t = 1;
                const cx = a.x + t * abx;
                const cy = a.y + t * aby;
                const dx = p.x - cx;
                const dy = p.y - cy;
                return (dx * dx) + (dy * dy);
            };
            const distSqToPolylinePx = (latlng, latlngs) => {
                try {
                    if (!this.map || !Array.isArray(latlngs) || latlngs.length < 2) return Number.POSITIVE_INFINITY;
                    const p = this.map.latLngToLayerPoint(latlng);
                    const pts = latlngs.map(ll => this.map.latLngToLayerPoint(ll));
                    let best = Number.POSITIVE_INFINITY;
                    for (let i = 0; i < pts.length - 1; i++) {
                        const d = distSqPointToSegment(p, pts[i], pts[i + 1]);
                        if (d < best) best = d;
                    }
                    return best;
                } catch (_) {
                    return Number.POSITIVE_INFINITY;
                }
            };
            const pickHoveredDirectionId = (routeId, latlng) => {
                const rid = parseInt(routeId || 0, 10);
                if (!rid) return null;
                const r = this._assumedRoutesById?.get?.(rid) || null;
                const dirIds = r?._direction_ids || [];
                if (!Array.isArray(dirIds) || !dirIds.length) return null;
                let bestId = null;
                let bestD = Number.POSITIVE_INFINITY;
                for (const did of dirIds) {
                    const ll = this._assumedBaseDirLatLngsById?.get?.(did) || null;
                    if (!ll) continue;
                    const d = distSqToPolylinePx(latlng, ll);
                    if (d < bestD) {
                        bestD = d;
                        bestId = did;
                    }
                }
                return bestId;
            };
            const popupHtmlForRoutes = (routeIds, title) => {
                const ids = Array.isArray(routeIds) ? routeIds : [];
                const items = ids
                    .map(x => parseInt(x, 10))
                    .filter(x => Number.isFinite(x) && x > 0)
                    .map(id => this._assumedRoutesById?.get?.(id))
                    .filter(Boolean)
                    .sort((a, b) => (a._index || 0) - (b._index || 0));
                const lines = items.map((r) => {
                    const owner = (r.owner_name || '').toString().trim() || 'Не определён';
                    return `${r._index}. ${esc(owner)} — ${esc(fmt(r.length_m))} м`;
                }).join('<br>');
                return `<div style="max-height:260px; overflow:auto; font-size:12px; line-height:1.4;">
                    <div style="font-weight:800; margin-bottom:6px;">${esc(title || 'Предполагаемые кабели')}</div>
                    ${lines || '<span style="color:var(--text-secondary);">Нет данных</span>'}
                </div>`;
            };
            const openPickPopupForDirection = (latlng, directionId) => {
                const did = parseInt(directionId || 0, 10);
                if (!did) return;
                const routeIds = this._assumedRouteIdsByDirectionId?.get?.(did) || [];
                const items = (Array.isArray(routeIds) ? routeIds : [])
                    .map(x => parseInt(x, 10))
                    .filter(x => Number.isFinite(x) && x > 0)
                    .map(id => this._assumedRoutesById?.get?.(id))
                    .filter(Boolean)
                    .sort((a, b) => (a._index || 0) - (b._index || 0));
                if (!items.length) return;

                const host = this.assumedSegmentPickerEl;
                if (!host) return;
                host.classList.remove('hidden');

                host.innerHTML = `
                    <div class="asp-header">
                        <div class="asp-title">Предполагаемые кабели (участок)</div>
                        <button type="button" class="asp-close" id="btn-asp-close" title="Закрыть">✕</button>
                    </div>
                    <div class="asp-body">
                        ${items.map((r) => {
                            const rid = parseInt(r?.route_id || 0, 10);
                            if (!rid) return '';
                            const owner = (r.owner_name || '').toString().trim() || 'Не определён';
                            const text = `${r._index}. ${owner} — ${fmt(r.length_m)} м`;
                            return `<button type="button" class="btn btn-sm btn-secondary asp-item" data-route-id="${rid}">${esc(text)}</button>`;
                        }).join('') || '<span style="color:var(--text-secondary);">Нет данных</span>'}
                    </div>
                `;

                try {
                    host.querySelector('#btn-asp-close')?.addEventListener('click', () => {
                        try { host.classList.add('hidden'); } catch (_) {}
                    });
                } catch (_) {}

                try {
                    host.querySelectorAll('button[data-route-id]').forEach((btn) => {
                        btn.addEventListener('click', () => {
                            const rid = parseInt(btn.getAttribute('data-route-id') || '0', 10);
                            if (!rid) return;
                            try { this.highlightAssumedRoute?.(rid); } catch (_) {}
                            try { this.setAssumedCablesPanelSelectedRoute?.(rid); } catch (_) {}
                        });
                    });
                } catch (_) {}
            };

            L.geoJSON({ type: 'FeatureCollection', features }, {
                pane: 'assumedCablesPane',
                interactive: true,
                style: (feature) => {
                    return {
                        weight: baseWeight + 2,
                        color: routeColor,
                        opacity: routeOpacity,
                        lineCap: 'round',
                        lineJoin: 'round',
                        bubblingMouseEvents: false,
                    };
                },
                onEachFeature: (feature, layer) => {
                    try {
                        const p = feature?.properties || {};
                        const routeId = parseInt(p.route_id || p.id || 0, 10);
                        layer._igsMeta = { objectType: 'assumed_cable_route', properties: { id: routeId, ...p } };
                        if (routeId) this._assumedRouteLayerById.set(routeId, layer);
                        // не даём клику "провалиться" в выбор объектов
                        layer.on('click', (e) => {
                            try { L.DomEvent.stopPropagation(e); } catch (_) {}
                            try {
                                const rid = parseInt(routeId || 0, 10);
                                if (!rid) return;
                                const did = pickHoveredDirectionId(rid, e.latlng);
                                if (!did) return;
                                openPickPopupForDirection(e.latlng, did);
                            } catch (_) {}
                        });
                        // hover: показать список предполагаемых кабелей
                        layer.on('mouseover', (e) => {
                            try {
                                if (!this._assumedRoutesById || this._assumedRoutesById.size <= 0) return;
                                if (!this._assumedRoutesPopup) {
                                    this._assumedRoutesPopup = L.popup({ maxWidth: 420, closeButton: false, autoClose: true, closeOnClick: false });
                                }
                                const rid = parseInt(routeId || 0, 10);
                                const did = pickHoveredDirectionId(rid, e.latlng);
                                let html = null;
                                if (did) {
                                    const routeIds = this._assumedRouteIdsByDirectionId?.get?.(did) || [];
                                    html = popupHtmlForRoutes(routeIds, 'Предполагаемые кабели (участок)');
                                } else if (rid) {
                                    html = popupHtmlForRoutes([rid], 'Предполагаемый кабель');
                                }
                                if (!html) return;
                                this._assumedRoutesPopup
                                    .setLatLng(e.latlng)
                                    .setContent(html);
                                this._assumedRoutesPopup.openOn(this.map);
                            } catch (_) {}
                        });
                        layer.on('mouseout', () => {
                            try {
                                if (this._assumedRoutesPopup) this.map.closePopup(this._assumedRoutesPopup);
                            } catch (_) {}
                        });
                    } catch (_) {}
                },
            }).addTo(this.layers.assumedCables);

            // кеш для hover popup: список всех маршрутов
            try {
                const list = await API.assumedCables.list(v);
                if (list?.success === false) throw new Error(list?.message || 'Ошибка');
                const rows = Array.isArray(list?.data?.rows) ? list.data.rows : (Array.isArray(list?.rows) ? list.rows : []);
                try { this._assumedRoutesById = new Map(); } catch (_) {}
                try { this._assumedRouteIdsByDirectionId = new Map(); } catch (_) {}
                rows.forEach((r, idx) => {
                    const rid = parseInt(r?.route_id || 0, 10);
                    if (!rid) return;
                    const dirIds = normDirectionIds(r?.direction_ids);
                    const rr = { ...(r || {}), _index: idx + 1, _direction_ids: dirIds };
                    this._assumedRoutesById.set(rid, rr);
                    for (const did of dirIds) {
                        if (!did) continue;
                        const arr = this._assumedRouteIdsByDirectionId.get(did) || [];
                        arr.push(rid);
                        this._assumedRouteIdsByDirectionId.set(did, arr);
                    }
                });
            } catch (_) {
                try { this._assumedRoutesById = new Map(); } catch (_) {}
                try { this._assumedRouteIdsByDirectionId = new Map(); } catch (_) {}
            }
        } catch (e) {
            console.error('Ошибка загрузки предполагаемых кабелей:', e);
        }
    },

    highlightAssumedRoute(routeId) {
        const id = parseInt(routeId || 0, 10);
        if (!id) return;
        const layer = this._assumedRouteLayerById?.get?.(id) || null;
        if (!layer) return;
        try {
            // красная подсветка (как кабель)
            const feat = layer.toGeoJSON?.();
            if (feat && feat.type === 'Feature' && feat.geometry) {
                this.highlightFeatureCollection?.({ type: 'FeatureCollection', features: [feat] });
            }
        } catch (_) {}
    },

    setAssumedCablesPanelSelectedRoute(routeId, opts = {}) {
        const id = parseInt(routeId || 0, 10);
        if (!id) return;
        const key = String(id);
        this._assumedCablesPanelSelectedKey = key;
        const el = this.assumedCablesPanelEl;
        if (!el || el.classList.contains('hidden')) return;
        try {
            const prev = el.querySelector('tbody tr.ac-row-selected');
            if (prev) prev.classList.remove('ac-row-selected');
            const tr = el.querySelector(`tbody tr[data-route-id="${id}"]`);
            if (tr) {
                tr.classList.add('ac-row-selected');
                if (opts?.scrollIntoView) {
                    try { tr.scrollIntoView({ block: 'nearest' }); } catch (_) {}
                }
            }
        } catch (_) {}
    },

    assumedVariantLabel(v) {
        const vv = [1, 2, 3].includes(Number(v)) ? Number(v) : 1;
        if (vv === 1) return 'Предполагаемые кабели - 1 - По магистральным графам';
        if (vv === 2) return 'Предполагаемые кабели - 2 - По локальным графам';
        return 'Предполагаемые кабели - 3 - По суммированным графам собственника';
    },

    setAssumedCablesPanelVisible(visible) {
        try {
            const el = this.assumedCablesPanelEl;
            if (!el) return;
            el.classList.toggle('hidden', !visible);
            try {
                document.body?.classList?.toggle?.('assumed-cables-panel-open', !!visible);
                if (visible) {
                    const w = Math.round(el.getBoundingClientRect?.().width || 520);
                    document.body?.style?.setProperty?.('--assumed-cables-panel-w', `${Math.max(280, w)}px`);
                } else {
                    document.body?.style?.removeProperty?.('--assumed-cables-panel-w');
                }
            } catch (_) {}
            if (!visible) {
                this._assumedCablesPanelSelectedKey = null;
                try {
                    const sp = this.assumedSegmentPickerEl;
                    if (sp) sp.classList.add('hidden');
                } catch (_) {}
            }
        } catch (_) {}
    },

    setInventoryRecommendationsPanelVisible(visible) {
        try {
            const el = this.inventoryRecommendationsPanelEl;
            if (!el) return;
            el.classList.toggle('hidden', !visible);
            try {
                document.body?.classList?.toggle?.('assumed-cables-panel-open', !!visible);
                if (visible) {
                    const w = Math.round(el.getBoundingClientRect?.().width || 520);
                    document.body?.style?.setProperty?.('--assumed-cables-panel-w', `${Math.max(280, w)}px`);
                } else {
                    document.body?.style?.removeProperty?.('--assumed-cables-panel-w');
                }
            } catch (_) {}
            if (!visible) {
                this._inventoryRecommendationsOwnerId = null;
                this._inventoryRecommendationsSelectedKey = null;
            }
        } catch (_) {}
    },

    async showInventoryRecommendationsPanel(ownerId) {
        const oid = parseInt(ownerId || 0, 10);
        if (!oid) return;
        try { App.switchPanel('map'); } catch (_) {}
        // не держим две правые панели одновременно
        try { this.setAssumedCablesPanelVisible(false); } catch (_) {}
        this._inventoryRecommendationsOwnerId = oid;
        this.setInventoryRecommendationsPanelVisible(true);
        await this.refreshInventoryRecommendationsPanel();
    },

    async refreshInventoryRecommendationsPanel() {
        const el = this.inventoryRecommendationsPanelEl;
        if (!el || el.classList.contains('hidden')) return;
        const oid = parseInt(this._inventoryRecommendationsOwnerId || 0, 10);
        if (!oid) return;
        try {
            const resp = await API.reports.inventoryRecommendations({ owner_id: oid });
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const data = resp?.data || resp;
            this.renderInventoryRecommendationsPanel(data);
        } catch (e) {
            this.renderInventoryRecommendationsPanel({
                owner_id: oid,
                owner_name: '',
                summary: { part1_count: 0, part2_count: 0, part3_count: 0 },
                parts: [],
                _error: e?.message || 'Ошибка загрузки',
            });
        }
    },

    renderInventoryRecommendationsPanel(payload) {
        const el = this.inventoryRecommendationsPanelEl;
        if (!el) return;
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const oid = parseInt(payload?.owner_id || 0, 10) || 0;
        const ownerName = (payload?.owner_name || '').toString().trim();
        const summary = payload?.summary || {};
        const c1 = Number(summary.part1_count || 0) || 0;
        const c2 = Number(summary.part2_count || 0) || 0;
        const c3 = Number(summary.part3_count || 0) || 0;
        const parts = Array.isArray(payload?.parts) ? payload.parts : [];
        const err = payload?._error ? `<span style="color: var(--danger-color);">${esc(payload._error)}</span>` : '';

        const sectionHtml = (part) => {
            const title = (part?.title || '').toString();
            const rows = Array.isArray(part?.rows) ? part.rows : [];
            const cnt = Number(part?.count || rows.length || 0) || 0;
            return `
                <div style="padding: 10px 14px; border-bottom: 1px solid var(--border-color);">
                    <div style="font-weight:800; margin-bottom:8px; color: var(--text-primary);">
                        ${esc(title)} — <span style="color: var(--text-secondary);">${esc(cnt)}</span>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th style="width:50px;">№</th>
                                <th style="width:140px;">№ Колодца</th>
                                <th>№ карточки</th>
                                <th style="width:110px;">Дата</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.length ? rows.map((r, idx) => {
                                const wid = Number(r.well_id || 0) || 0;
                                const wnum = (r.well_number || '').toString();
                                const cnum = (r.card_number || '').toString();
                                const cdate = (r.card_date || '').toString();
                                const key = `${part?.code || title}:${wid}`;
                                const selected = (this._inventoryRecommendationsSelectedKey === key) ? 'ac-row-selected' : '';
                                return `
                                    <tr class="${selected}" data-well-id="${esc(wid)}" data-key="${esc(key)}">
                                        <td>${idx + 1}</td>
                                        <td>${esc(wnum || wid)}</td>
                                        <td>${esc(cnum || '-')}</td>
                                        <td>${esc(cdate || '-')}</td>
                                    </tr>
                                `;
                            }).join('') : `
                                <tr><td colspan="4" style="color: var(--text-secondary);">Нет данных</td></tr>
                            `}
                        </tbody>
                    </table>
                </div>
            `;
        };

        el.innerHTML = `
            <div class="ac-header">
                <div class="ac-title" title="Рекомендации по инвентаризации">Рекомендации по инвентаризации</div>
                <button type="button" class="ac-close" id="btn-ir-close" title="Закрыть">✕</button>
            </div>
            <div class="ac-sub">
                <div>
                    <div><b>Не инвентаризированные колодцы</b> — ${esc(c1)}</div>
                    <div><b>Инвентаризация старше более 2 лет</b> — ${esc(c2)}</div>
                    <div><b>По числу неучтенных кабелей</b> — ${esc(c3)}${err ? ` — ${err}` : ''}</div>
                </div>
                <div class="ac-actions">
                    <button type="button" class="btn btn-sm btn-secondary" id="btn-ir-export" ${oid ? '' : 'disabled'}>
                        <i class="fas fa-file-export"></i> Выгрузить
                    </button>
                </div>
            </div>
            <div class="ac-body">
                ${parts.map(sectionHtml).join('')}
            </div>
        `;

        try {
            el.querySelector('#btn-ir-close')?.addEventListener('click', () => {
                try { this.setInventoryRecommendationsPanelVisible(false); } catch (_) {}
            });
        } catch (_) {}

        try {
            el.querySelector('#btn-ir-export')?.addEventListener('click', () => {
                if (!oid) return;
                try { App?.showInventoryRecommendationsExportModal?.(oid); } catch (_) {}
            });
        } catch (_) {}

        // click row -> show well on map + highlight (без сброса скролла)
        try {
            el.querySelectorAll('tbody tr[data-well-id]').forEach((tr) => {
                tr.addEventListener('click', async () => {
                    const wid = parseInt(tr.getAttribute('data-well-id') || '0', 10);
                    const key = tr.getAttribute('data-key') || '';
                    if (!wid) return;
                    this._inventoryRecommendationsSelectedKey = key;
                    try {
                        el.querySelectorAll('tbody tr.ac-row-selected').forEach((x) => x.classList.remove('ac-row-selected'));
                        tr.classList.add('ac-row-selected');
                    } catch (_) {}
                    try {
                        await this.showObjectOnMap('well', wid);
                        this.highlightSelectedObject?.('well', wid);
                    } catch (_) {}
                });
            });
        } catch (_) {}
    },

    async refreshAssumedCablesPanel() {
        const el = this.assumedCablesPanelEl;
        if (!el || el.classList.contains('hidden')) return;
        const v = [1, 2, 3].includes(Number(this.assumedCablesVariantNo)) ? Number(this.assumedCablesVariantNo) : 1;
        try {
            const resp = await API.assumedCables.list(v);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const data = resp?.data || resp;
            this.renderAssumedCablesPanel(data);
        } catch (e) {
            this.renderAssumedCablesPanel({
                variant_no: v,
                scenario_id: null,
                built_at: null,
                summary: { unaccounted_total_count: 0, unaccounted_total_length_m: 0, assumed_total_count: 0, assumed_total_length_m: 0, rows: 0 },
                rows: [],
                _error: e?.message || 'Ошибка загрузки',
            });
        }
    },

    renderAssumedCablesPanel(payload) {
        const el = this.assumedCablesPanelEl;
        if (!el) return;
        const v = [1, 2, 3].includes(Number(payload?.variant_no)) ? Number(payload.variant_no) : ([1, 2, 3].includes(Number(this.assumedCablesVariantNo)) ? Number(this.assumedCablesVariantNo) : 1);
        const summary = payload?.summary || {};
        const unaccCnt = Number(summary.unaccounted_total_count || 0) || 0;
        const unaccLen = Number(summary.unaccounted_total_length_m || 0) || 0;
        const assumedCnt = Number(summary.assumed_total_count || 0) || 0;
        const assumedLen = Number(summary.assumed_total_length_m || 0) || 0;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];

        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const fmtNum = (n) => {
            const x = Number(n);
            if (!Number.isFinite(x)) return '-';
            return String(Math.round(x * 100) / 100);
        };

        const title = this.assumedVariantLabel(v);
        const err = payload?._error ? `<span style="color: var(--danger-color);">${esc(payload._error)}</span>` : '';

        el.innerHTML = `
            <div class="ac-header">
                <div class="ac-title" title="${esc(title)}">${esc(title)}</div>
                <button type="button" class="ac-close" id="btn-ac-close" title="Закрыть">✕</button>
            </div>
            <div class="ac-sub">
                <div>
                    <div>Количество неучтенных отрезков: <b>${esc(unaccCnt)}</b></div>
                    <div>Протяженность неучтенный кабелей: <b>${esc(fmtNum(unaccLen))}</b> м</div>
                    <div>Количество предполагаемых кабелей: <b>${esc(assumedCnt)}</b></div>
                    <div>Протяженность предполагаемых кабелей: <b>${esc(fmtNum(assumedLen))}</b> м${err ? ` — ${err}` : ''}</div>
                </div>
                <div class="ac-actions">
                    <button type="button" class="btn btn-sm btn-secondary" id="btn-ac-export">
                        <i class="fas fa-file-export"></i> Выгрузить
                    </button>
                </div>
            </div>
            <div class="ac-body">
                <table>
                    <thead>
                        <tr>
                            <th style="width:50px;">№</th>
                            <th style="width:180px;">Собственник</th>
                            <th style="width:90px;">Длина (м)</th>
                            <th>Колодец нач.</th>
                            <th>Колодец кон.</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map((r, idx) => {
                            const routeId = Number(r.route_id || 0) || 0;
                            const ownerName = (r.owner_name || '').toString().trim() || 'Не определён';
                            const len = fmtNum(r.length_m);
                            const sw = (r.start_well_number || '').toString();
                            const ew = (r.end_well_number || '').toString();
                            const key = String(routeId);
                            const selected = (this._assumedCablesPanelSelectedKey === key) ? 'ac-row-selected' : '';
                            return `
                                <tr class="${selected}" data-route-id="${esc(routeId)}" data-key="${esc(key)}">
                                    <td>${idx + 1}</td>
                                    <td>${esc(ownerName)}</td>
                                    <td>${esc(len)}</td>
                                    <td>${esc(sw)}</td>
                                    <td>${esc(ew)}</td>
                                </tr>
                            `;
                        }).join('') : `
                            <tr><td colspan="5" style="color: var(--text-secondary);">Нет данных. Включите режим “Предполагаемые кабели” в слое “Инвентаризация” и нажмите “Пересчитать”.</td></tr>
                        `}
                    </tbody>
                </table>
            </div>
        `;

        // close: снять галочку слоя
        try {
            el.querySelector('#btn-ac-close')?.addEventListener('click', () => {
                try {
                    if (typeof App !== 'undefined' && App?.setAssumedCablesModeEnabled) {
                        App.setAssumedCablesModeEnabled(false, { ensureInventoryOn: false });
                    } else {
                        this.setAssumedCablesPanelVisible(false);
                    }
                } catch (_) {
                    this.setAssumedCablesPanelVisible(false);
                }
            });
        } catch (_) {}

        // export
        try {
            el.querySelector('#btn-ac-export')?.addEventListener('click', () => {
                try { App?.showAssumedCablesExportModal?.(); } catch (_) {}
            });
        } catch (_) {}

        // row click -> highlight + fit to route
        try {
            el.querySelectorAll('tbody tr[data-route-id]').forEach((tr) => {
                tr.addEventListener('click', async () => {
                    const routeId = parseInt(tr.getAttribute('data-route-id') || '0', 10);
                    const key = tr.getAttribute('data-key') || '';
                    if (!routeId) return;
                    this._assumedCablesPanelSelectedKey = key;
                    try {
                        // обновим выделение без перерендера (чтобы не сбрасывать скролл)
                        el.querySelectorAll('tbody tr.ac-row-selected').forEach((x) => x.classList.remove('ac-row-selected'));
                        tr.classList.add('ac-row-selected');
                    } catch (_) {}
                    try { this.highlightAssumedRoute?.(routeId); } catch (_) {}
                    try {
                        const layer = this._assumedRouteLayerById?.get?.(routeId) || null;
                        const b = layer?.getBounds?.();
                        if (b && b.isValid && b.isValid()) {
                            this.fitToBounds(b, 17);
                        }
                    } catch (_) {}
                });
            });
        } catch (_) {}
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
                    style: (feature) => {
                        const props = feature?.properties || {};
                        const style = {
                            color: (this.ownersLegendEnabled && props?.owner_color)
                                ? props.owner_color
                                : this.getPlannedOverrideColor(props, this.colors.channels),
                            weight: this.getDirectionLineWeight(),
                            opacity: 0.8,
                        };
                        // Статус "inbuilding": линия прерывистая (без изменения цветовой схемы)
                        if ((props.status_code || '').toString().trim().toLowerCase() === 'inbuilding') {
                            style.dashArray = '6, 6';
                        }
                        return style;
                    },
                    onEachFeature: (feature, layer) => {
                        layer._igsMeta = { objectType: 'channel_direction', properties: feature.properties };
                        layer.on('click', async (e) => {
                            if (this.addDuctCableMode) {
                                L.DomEvent.stopPropagation(e);
                                await this.handleDirectionClickForDuctCable(feature.properties?.id);
                                return;
                            }
                            L.DomEvent.stopPropagation(e);
                            this.handleObjectsClick(e);
                        });
                        
                        layer.bindTooltip(`
                            <strong>Направление: ${feature.properties.number}</strong><br>
                            ${feature.properties.start_well || '-'} → ${feature.properties.end_well || '-'}<br>
                            Каналов: ${feature.properties.channels || 0}
                        `, { permanent: false, sticky: true });
                    },
                }).addTo(this.layers.channels);
            }
            if (this.directionLengthLabelsEnabled) this.rebuildDirectionLengthLabelsFromDirectionsLayer();
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
                        return this.createMarkerPostMarker(latlng, feature?.properties || {});
                    },
                    onEachFeature: (feature, layer) => {
                        layer._igsMeta = { objectType: 'marker_post', properties: feature.properties };
                        layer.on('click', (e) => {
                            L.DomEvent.stopPropagation(e);
                            this.handleObjectsClick(e);
                        });
                        
                        layer.bindTooltip(`
                            <strong>Столбик: ${feature.properties.number || '-'}</strong><br>
                            Статус: ${feature.properties.status_name || '-'}
                        `, { permanent: false, direction: 'top' });
                    },
                }).addTo(this.layers.markers);
            }
            if (this.objectCoordinatesLabelsEnabled) this.rebuildObjectCoordinatesLabelsFromPointLayers();
            this.updateObjectCoordinatesLabelsVisibility();
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
                        color: this.getPlannedOverrideColor(
                            feature?.properties,
                            feature.properties.object_type_color || feature.properties.status_color || color
                        ),
                        weight: this.getCableLineWeight(),
                        opacity: 0.8,
                        dashArray: type === 'aerial' ? '5, 5' : null,
                    }),
                    onEachFeature: (feature, layer) => {
                        layer._igsMeta = { objectType: 'unified_cable', properties: feature.properties };
                        layer.on('click', (e) => {
                            L.DomEvent.stopPropagation(e);
                            this.handleObjectsClick(e);
                        });
                        
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

    // e: Leaflet MouseEvent
    handleObjectsClick(e) {
        if (this._suppressClickOnce) {
            this._suppressClickOnce = false;
            return;
        }
        const latlng = e?.latlng || e;
        if (this.rulerMode) {
            try { this.addRulerPoint(latlng); } catch (_) {}
            return;
        }
        const hits = this.getObjectsAtLatLng(latlng);
        this.lastClickHits = hits;

        const isCtrl = !!(e?.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey));

        // Множественный выбор (Ctrl+клик) — только в обычном режиме
        if (isCtrl && !this.groupPickMode && !this.incidentSelectMode && !this.inventoryMode && !this.addDirectionMode && !this.addingObject && !this.addCableMode && !this.addDuctCableMode) {
            if (hits.length <= 1) {
                const h = hits[0];
                if (h) this.toggleMultiSelection(h);
                return;
            }
            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(hits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectObjectForMultiFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите объект для добавления/исключения из выделения.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            App.showModal('Множественный выбор', content, footer);
            return;
        }

        // Выбор объекта для добавления в группу
        if (this.groupPickMode) {
            if (hits.length <= 1) {
                const h = hits[0];
                if (h) {
                    const gid = this.groupPickGroupId;
                    this.groupPickMode = false;
                    this.groupPickGroupId = null;
                    if (this.map) this.map.getContainer().style.cursor = '';
                    App.addGroupObjectFromMap(gid, h);
                }
                return;
            }

            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(hits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectGroupObjectFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите объект для добавления в группу.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            App.showModal('Выберите объект', content, footer);
            return;
        }

        // Выбор объекта для инцидента
        if (this.incidentSelectMode) {
            if (hits.length <= 1) {
                const h = hits[0];
                if (h) {
                    this.incidentSelectMode = false;
                    App.addIncidentRelatedObjectFromMap(h);
                }
                return;
            }

            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(hits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectIncidentObjectFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите объект для привязки к инциденту.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            App.showModal('Выберите объект', content, footer);
            return;
        }

        // "Режим инвентаризация" (ввод кол-ва кабелей по направлениям колодца)
        if (this.inventoryMode) {
            const wellHits = (hits || []).filter(h => h?.objectType === 'well');
            const pickWell = (h) => {
                if (!h) return;
                const wid = parseInt(h?.properties?.id || 0, 10);
                if (!wid) return;
                this._inventoryPickWell?.(h?.properties || {});
            };
            if (wellHits.length <= 1) {
                if (!wellHits.length) {
                    App.notify('Выберите колодец', 'warning');
                    return;
                }
                pickWell(wellHits[0]);
                return;
            }
            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(wellHits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager._inventoryPickWellFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите колодец.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            this._inventoryWellHits = wellHits;
            App.showModal('Выберите колодец', content, footer);
            return;
        }

        // "Создать кабель в канализации по кратчайшему пути"
        if (this.shortestDuctCableMode) {
            const wellHits = (hits || []).filter(h => h?.objectType === 'well');
        const pickWell = (h) => {
                if (!h) return;
            if (this.shortestDuctCableBusy) return;
                const wid = parseInt(h?.properties?.id || 0, 10);
                if (!wid) return;
                const num = (h?.properties?.number || '').toString();
                if (!this.shortestDuctCableStartWell) {
                    this.shortestDuctCableStartWell = { id: wid, number: num };
                this.shortestDuctCableEndWell = null;
                this.shortestDuctCableCableId = null;
                this.shortestDuctCableRouteChannelIds = [];
                this.shortestDuctCableRouteDirectionIds = [];
                App.notify(`Старт: ${num || wid}. Выберите следующий колодец.`, 'info');
                    return;
                }
            // Если кабель уже создан — достраиваем его по следующим колодцам
            if (this.shortestDuctCableCableId) {
                if (wid === this.shortestDuctCableStartWell.id) {
                    App.notify('Следующий колодец должен отличаться от текущего', 'warning');
                    return;
                }
                this.shortestDuctCableEndWell = { id: wid, number: num };
                this.shortestDuctCableBusy = true;
                try {
                    Promise.resolve(App.extendShortestDuctCableToWell?.(
                        this.shortestDuctCableCableId,
                        this.shortestDuctCableStartWell,
                        this.shortestDuctCableEndWell
                    )).finally(() => {
                        this.shortestDuctCableBusy = false;
                    });
                } catch (_) {
                    this.shortestDuctCableBusy = false;
                }
                return;
            }

            if (!this.shortestDuctCableEndWell) {
                    if (wid === this.shortestDuctCableStartWell.id) {
                        App.notify('Конечный колодец должен отличаться от начального', 'warning');
                        return;
                    }
                    this.shortestDuctCableEndWell = { id: wid, number: num };
                    // строим маршрут
                    try { App.previewShortestDuctCablePath?.(this.shortestDuctCableStartWell, this.shortestDuctCableEndWell); } catch (_) {}
                    return;
                }
            // Если конечный колодец уже выбран, но кабель ещё не создан — НЕ пересчитываем "от первого до нового".
            // Фиксируем текущий сегмент (Start->End), добавляем его в планируемый маршрут и считаем следующий сегмент (End->Next),
            // исключая уже использованные направления/каналы.
            try {
                Promise.resolve(App.appendShortestDuctCablePlannedSegmentAndPreviewNext?.({ id: wid, number: num }))
            } catch (_) {
            }
            };

            if (wellHits.length <= 1) {
                if (!wellHits.length) {
                    App.notify('Выберите колодец', 'warning');
                    return;
                }
                pickWell(wellHits[0]);
                return;
            }
            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(wellHits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectShortestPathWellFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите колодец.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            this._shortestWellHits = wellHits;
            App.showModal('Выберите колодец', content, footer);
            return;
        }

        // "Переложить кабель в канализации"
        if (this.relocateDuctCableMode) {
            // шаг 1: выбрать кабель в канализации
            if (!this.relocateDuctCableId) {
                const ductHits = (hits || []).filter(h => h?.objectType === 'unified_cable' && (h?.properties?.object_type_code || '') === 'cable_duct');
                const pick = async (h) => {
                    if (!h) return;
                    const cid = parseInt(h?.properties?.id || 0, 10);
                    if (!cid) return;
                    this.relocateDuctCableId = cid;
                    try {
                        const resp = await API.unifiedCables.get(cid);
                        const c = resp?.data || resp || {};
                        const rcs = Array.isArray(c.route_channels) ? c.route_channels : [];
                        // ожидаем cc.direction_id в ответе (добавлено в API)
                        this.relocateDuctCableRouteChannels = (rcs || []).map(rc => ({
                            cable_channel_id: parseInt(rc?.cable_channel_id || 0, 10),
                            direction_id: parseInt(rc?.direction_id || 0, 10),
                            route_order: parseInt(rc?.route_order || 0, 10) || 0,
                        })).filter(x => x.cable_channel_id > 0 && x.direction_id > 0);
                    } catch (_) {
                        this.relocateDuctCableRouteChannels = [];
                    }
                    try { this.highlightCableRouteDirections(cid); } catch (_) {}
                    App.notify('Кабель выбран. Кликните по направлению: клик по направлению из маршрута — удалить, по другому — добавить канал.', 'info');
                };

                if (ductHits.length <= 1) {
                    if (!ductHits.length) {
                        App.notify('Выберите кабель в канализации', 'warning');
                        return;
                    }
                    pick(ductHits[0]);
                    return;
                }

                this.relocateDuctCablePickCandidates = ductHits;
                const content = `
                    <div style="max-height: 60vh; overflow:auto;">
                        ${(ductHits || []).map((h, idx) => `
                            <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectRelocateDuctCableFromHits(${idx})">
                                ${h.title}
                            </button>
                        `).join('')}
                    </div>
                    <p class="text-muted" style="margin-top:8px;">Выберите кабель в канализации.</p>
                `;
                const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
                App.showModal('Переложить кабель', content, footer);
                return;
            }

            // шаг 2: клик по направлению — удалить/добавить
            const dirHits = (hits || []).filter(h => h?.objectType === 'channel_direction');
            const pickDir = async (h) => {
                if (!h) return;
                const directionId = parseInt(h?.properties?.id || 0, 10);
                if (!directionId) return;

                const inRoute = (this.relocateDuctCableRouteChannels || []).some(x => parseInt(x.direction_id || 0, 10) === directionId);
                if (inRoute) {
                    // удаляем все каналы маршрута, которые относятся к этому направлению
                    const kept = (this.relocateDuctCableRouteChannels || []).filter(x => parseInt(x.direction_id || 0, 10) !== directionId);
                    // сохраняем исходный порядок route_order, затем собираем ids
                    kept.sort((a, b) => (a.route_order || 0) - (b.route_order || 0));
                    const newIds = kept.map(x => x.cable_channel_id);
                    try {
                        const resp = await API.unifiedCables.update(this.relocateDuctCableId, { route_channels: newIds });
                        if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                        // обновляем кэш маршрута
                        const r = await API.unifiedCables.get(this.relocateDuctCableId);
                        const c = r?.data || r || {};
                        const rcs = Array.isArray(c.route_channels) ? c.route_channels : [];
                        this.relocateDuctCableRouteChannels = (rcs || []).map(rc => ({
                            cable_channel_id: parseInt(rc.cable_channel_id || 0, 10),
                            direction_id: parseInt(rc.direction_id || 0, 10),
                            route_order: parseInt(rc.route_order || 0, 10) || 0,
                        })).filter(x => x.cable_channel_id && x.direction_id);
                        try {
                            if (newIds.length) this.highlightCableRouteDirections(this.relocateDuctCableId);
                            else this.clearHighlight();
                        } catch (_) {}
                        App.notify('Участок удалён из маршрута', 'success');
                    } catch (e) {
                        App.notify(e?.message || 'Ошибка изменения маршрута', 'error');
                    }
                    return;
                }

                // добавить: выбрать канал направления
                try {
                    const resp = await API.channelDirections.get(directionId);
                    const dir = resp?.data || resp || {};
                    const channels = Array.isArray(dir.channels) ? dir.channels : [];
                    if (!channels.length) {
                        App.notify('У направления нет каналов', 'warning');
                        return;
                    }
                    this.relocateDuctCablePendingDirection = { directionId, channels };
                    const content = `
                        <div style="max-height: 60vh; overflow:auto;">
                            ${(channels || []).map((ch) => `
                                <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectRelocateDuctCableChannel(${parseInt(ch.id, 10)})">
                                    Канал ${ch.channel_number}${ch.kind_name ? ` — ${String(ch.kind_name).replace(/</g, '&lt;')}` : ''}
                                </button>
                            `).join('')}
                        </div>
                        <p class="text-muted" style="margin-top:8px;">Выберите канал, который нужно добавить в маршрут кабеля.</p>
                    `;
                    const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
                    App.showModal('Добавить канал в маршрут', content, footer);
                } catch (e) {
                    App.notify('Не удалось загрузить каналы направления', 'error');
                }
            };

            if (dirHits.length <= 1) {
                if (!dirHits.length) {
                    App.notify('Кликните по направлению (линии)', 'warning');
                    return;
                }
                pickDir(dirHits[0]);
                return;
            }
            // несколько направлений под курсором
            this.relocateDuctCableDirectionPickCandidates = dirHits;
            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(dirHits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectRelocateDirectionFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите направление.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            App.showModal('Выберите направление', content, footer);
            return;
        }

        // "Переместить точечный объект"
        if (this.movePointMode) {
            if (!this.movePointSelected) {
                const pointHits = (hits || []).filter(h => h?.objectType === 'well' || h?.objectType === 'marker_post');
                const pick = (h) => {
                    if (!h) return;
                    const objType = h.objectType;
                    const id = parseInt(h?.properties?.id || 0, 10);
                    if (!id) return;
                    const layer = this.findLayerByMeta(objType, id);
                    const ll = layer?.getLatLng?.();
                    if (!ll) {
                        App.notify('Не удалось определить координаты объекта', 'error');
                        return;
                    }
                    this.movePointSelected = { objectType: objType, id, origLatLng: ll, newLatLng: ll };
                    try {
                        if (this.movePointMarker) this.map.removeLayer(this.movePointMarker);
                    } catch (_) {}
                    this.movePointMarker = L.marker(ll, {
                        draggable: true,
                        autoPan: true,
                        keyboard: false,
                        opacity: 0.9,
                    }).addTo(this.map);
                    this.movePointMarker.on('dragend', () => {
                        try {
                            const nll = this.movePointMarker.getLatLng();
                            this.movePointSelected.newLatLng = nll;
                        } catch (_) {}
                    });
                    App.notify('Перетащите маркер в новое место и нажмите Enter или кнопку перемещения ещё раз', 'info');
                };

                if (pointHits.length <= 1) {
                    if (!pointHits.length) {
                        App.notify('Выберите колодец или столбик', 'warning');
                        return;
                    }
                    pick(pointHits[0]);
                    return;
                }
                // несколько объектов — выбор
                this.movePointPickCandidates = pointHits;
                const content = `
                    <div style="max-height: 60vh; overflow:auto;">
                        ${(pointHits || []).map((h, idx) => `
                            <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectMovePointFromHits(${idx})">
                                ${h.title}
                            </button>
                        `).join('')}
                    </div>
                    <p class="text-muted" style="margin-top:8px;">Выберите точечный объект для перемещения.</p>
                `;
                const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
                App.showModal('Переместить объект', content, footer);
                return;
            }
            // если объект уже выбран — дальнейшие клики игнорируем (перемещение drag&drop)
            return;
        }

        // "Набить колодец": выбираем направление
        if (this.stuffWellMode) {
            // запоминаем координаты клика, чтобы новый колодец создавался в точке клика
            try { this.lastClickLatLng = e?.latlng || null; } catch (_) { this.lastClickLatLng = null; }
            const pick = (h) => {
                if (!h) return;
                if (h.objectType !== 'channel_direction') {
                    App.notify('Выберите объект направления', 'warning');
                    return;
                }
                this.stuffWellMode = false;
                if (this.map) this.map.getContainer().style.cursor = '';
                document.getElementById('btn-stuff-well-map')?.classList?.toggle('active', false);
                try {
                    const props = Object.assign({}, (h.properties || {}), { __clickLatLng: this.lastClickLatLng });
                    App.openStuffWellFromDirection?.(props);
                } catch (_) {}
            };

            if (hits.length <= 1) {
                pick(hits[0]);
                return;
            }
            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(hits || []).map((h, idx) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectStuffWellDirectionFromHits(${idx})">
                            ${h.title}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите направление для набивки колодца.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            App.showModal('Выберите направление', content, footer);
            return;
        }

        if (hits.length <= 1) {
            const h = hits[0];
            if (h) this.showObjectInfo(h.objectType, h.properties);
            return;
        }

        const content = `
            <div style="max-height: 60vh; overflow:auto;">
                ${(hits || []).map((h, idx) => `
                    <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectObjectFromHits(${idx})">
                        ${h.title}
                    </button>
                `).join('')}
            </div>
            <p class="text-muted" style="margin-top:8px;">Выберите объект для просмотра информации.</p>
        `;
        const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
        App.showModal('Выберите объект', content, footer);
    },

    selectStuffWellDirectionFromHits(idx) {
        const h = (this.lastClickHits || [])[idx];
        if (!h) return;
        App.hideModal();
        if (h.objectType !== 'channel_direction') {
            App.notify('Выберите объект направления', 'warning');
            return;
        }
        this.stuffWellMode = false;
        if (this.map) this.map.getContainer().style.cursor = '';
        document.getElementById('btn-stuff-well-map')?.classList?.toggle('active', false);
        try {
            const props = Object.assign({}, (h.properties || {}), { __clickLatLng: this.lastClickLatLng || null });
            App.openStuffWellFromDirection?.(props);
        } catch (_) {}
    },

    async selectRelocateDuctCableFromHits(idx) {
        const h = (this.relocateDuctCablePickCandidates || [])[idx];
        if (!h) return;
        App.hideModal();
        await this._relocateSelectCableHit(h);
    },

    async selectRelocateDirectionFromHits(idx) {
        const h = (this.relocateDuctCableDirectionPickCandidates || [])[idx];
        if (!h) return;
        App.hideModal();
        await this._relocateHandleDirectionHit(h);
    },

    async selectRelocateDuctCableChannel(channelId) {
        const cid = parseInt(channelId || 0, 10);
        if (!cid) return;
        App.hideModal();
        await this._relocateAddChannel(cid);
    },

    selectMovePointFromHits(idx) {
        const h = (this.movePointPickCandidates || [])[idx];
        if (!h) return;
        App.hideModal();
        try {
            if (h?.objectType !== 'well' && h?.objectType !== 'marker_post') return;
            const id = parseInt(h?.properties?.id || 0, 10);
            if (!id) return;
            const layer = this.findLayerByMeta(h.objectType, id);
            const ll = layer?.getLatLng?.();
            if (!ll) return;
            this.movePointSelected = { objectType: h.objectType, id, origLatLng: ll, newLatLng: ll };
            if (this.movePointMarker) this.map.removeLayer(this.movePointMarker);
            this.movePointMarker = L.marker(ll, { draggable: true, autoPan: true, keyboard: false, opacity: 0.9 }).addTo(this.map);
            this.movePointMarker.on('dragend', () => {
                try { this.movePointSelected.newLatLng = this.movePointMarker.getLatLng(); } catch (_) {}
            });
            App.notify('Перетащите маркер в новое место и нажмите Enter или кнопку перемещения ещё раз', 'info');
        } catch (_) {}
    },

    selectShortestPathWellFromHits(idx) {
        const h = (this._shortestWellHits || [])[idx];
        if (!h) return;
        App.hideModal();
        // делегируем обратно в handleObjectsClick через прямую обработку
        try {
            // имитируем клик по выбранному объекту
            const wid = parseInt(h?.properties?.id || 0, 10);
            const num = (h?.properties?.number || '').toString();
            if (!wid) return;
            if (!this.shortestDuctCableStartWell) {
                this.shortestDuctCableStartWell = { id: wid, number: num };
                this.shortestDuctCableEndWell = null;
                this.shortestDuctCableCableId = null;
                this.shortestDuctCableRouteChannelIds = [];
                this.shortestDuctCableRouteDirectionIds = [];
                App.notify(`Старт: ${num || wid}. Выберите следующий колодец.`, 'info');
                return;
            }
            if (this.shortestDuctCableBusy) return;
            if (this.shortestDuctCableCableId) {
                if (wid === this.shortestDuctCableStartWell.id) {
                    App.notify('Следующий колодец должен отличаться от текущего', 'warning');
                    return;
                }
                this.shortestDuctCableEndWell = { id: wid, number: num };
                this.shortestDuctCableBusy = true;
                try {
                    Promise.resolve(App.extendShortestDuctCableToWell?.(
                        this.shortestDuctCableCableId,
                        this.shortestDuctCableStartWell,
                        this.shortestDuctCableEndWell
                    )).finally(() => {
                        this.shortestDuctCableBusy = false;
                    });
                } catch (_) {
                    this.shortestDuctCableBusy = false;
                }
                return;
            }
            if (!this.shortestDuctCableEndWell) {
                if (wid === this.shortestDuctCableStartWell.id) {
                    App.notify('Конечный колодец должен отличаться от начального', 'warning');
                    return;
                }
                this.shortestDuctCableEndWell = { id: wid, number: num };
                try { App.previewShortestDuctCablePath?.(this.shortestDuctCableStartWell, this.shortestDuctCableEndWell); } catch (_) {}
                return;
            }
            // Если конечный колодец уже выбран, но кабель ещё не создан — НЕ пересчитываем "от первого до нового".
            // Фиксируем текущий сегмент (Start->End), добавляем его в планируемый маршрут и считаем следующий сегмент (End->Next),
            // исключая уже использованные направления/каналы.
            try {
                Promise.resolve(App.appendShortestDuctCablePlannedSegmentAndPreviewNext?.({ id: wid, number: num }))
            } catch (_) {
            }
        } catch (_) {}
    },

    _inventoryPickWellFromHits(idx) {
        try {
            const h = (this._inventoryWellHits || [])[idx];
            if (!h) return;
            App.hideModal();
            this._inventoryWellHits = [];
            this._inventoryPickWell?.(h?.properties || {});
        } catch (_) {}
    },

    toggleShortestDuctCableMode() {
        this.shortestDuctCableMode = !this.shortestDuctCableMode;
        if (this.shortestDuctCableMode) {
            this.shortestDuctCableStartWell = null;
            this.shortestDuctCableEndWell = null;
            this.shortestDuctCableCableId = null;
            this.shortestDuctCableRouteChannelIds = [];
            this.shortestDuctCableRouteDirectionIds = [];
            this.shortestDuctCableBusy = false;
            this._shortestWellHits = [];
            if (this.map) this.map.getContainer().style.cursor = 'crosshair';
            App.notify('Кратчайший путь: выберите стартовый колодец', 'info');
        } else {
            this.shortestDuctCableStartWell = null;
            this.shortestDuctCableEndWell = null;
            this.shortestDuctCableCableId = null;
            this.shortestDuctCableRouteChannelIds = [];
            this.shortestDuctCableRouteDirectionIds = [];
            this.shortestDuctCableBusy = false;
            this._shortestWellHits = [];
            if (this.map) this.map.getContainer().style.cursor = '';
            try { this.clearHighlight(); } catch (_) {}
            try { App.notify('Кратчайший путь: режим выключен', 'info'); } catch (_) {}
        }
    },

    async _relocateSelectCableHit(h) {
        if (!h || h.objectType !== 'unified_cable') return;
        const cid = parseInt(h?.properties?.id || 0, 10);
        const code = (h?.properties?.object_type_code || '').toString();
        if (!cid || code !== 'cable_duct') {
            App.notify('Выберите кабель в канализации', 'warning');
            return;
        }
        this.relocateDuctCableId = cid;
        try {
            const resp = await API.unifiedCables.get(cid);
            const c = resp?.data || resp || {};
            const rcs = Array.isArray(c.route_channels) ? c.route_channels : [];
            this.relocateDuctCableRouteChannels = (rcs || []).map(rc => ({
                cable_channel_id: parseInt(rc?.cable_channel_id || 0, 10),
                direction_id: parseInt(rc?.direction_id || 0, 10),
                route_order: parseInt(rc?.route_order || 0, 10) || 0,
            })).filter(x => x.cable_channel_id > 0 && x.direction_id > 0);
        } catch (_) {
            this.relocateDuctCableRouteChannels = [];
        }
        try { this.highlightCableRouteDirections(cid); } catch (_) {}
        App.notify('Кабель выбран. Кликните по направлению: удалить/добавить канал.', 'info');
    },

    async _relocateHandleDirectionHit(h) {
        if (!this.relocateDuctCableMode || !this.relocateDuctCableId) return;
        if (!h || h.objectType !== 'channel_direction') {
            App.notify('Кликните по направлению (линии)', 'warning');
            return;
        }
        const directionId = parseInt(h?.properties?.id || 0, 10);
        if (!directionId) return;

        const inRoute = (this.relocateDuctCableRouteChannels || []).some(x => parseInt(x.direction_id || 0, 10) === directionId);
        if (inRoute) {
            const kept = (this.relocateDuctCableRouteChannels || []).filter(x => parseInt(x.direction_id || 0, 10) !== directionId);
            kept.sort((a, b) => (a.route_order || 0) - (b.route_order || 0));
            const newIds = kept.map(x => x.cable_channel_id);
            try {
                const resp = await API.unifiedCables.update(this.relocateDuctCableId, { route_channels: newIds });
                if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                const r = await API.unifiedCables.get(this.relocateDuctCableId);
                const c = r?.data || r || {};
                const rcs = Array.isArray(c.route_channels) ? c.route_channels : [];
                this.relocateDuctCableRouteChannels = (rcs || []).map(rc => ({
                    cable_channel_id: parseInt(rc?.cable_channel_id || 0, 10),
                    direction_id: parseInt(rc?.direction_id || 0, 10),
                    route_order: parseInt(rc?.route_order || 0, 10) || 0,
                })).filter(x => x.cable_channel_id > 0 && x.direction_id > 0);
                try {
                    if (newIds.length) this.highlightCableRouteDirections(this.relocateDuctCableId);
                    else this.clearHighlight();
                } catch (_) {}
                // Обновляем слой duct-кабелей, чтобы геометрия/длина на карте были актуальны
                try { await this.loadCables('duct'); } catch (_) {}
                App.notify('Участок удалён из маршрута', 'success');
            } catch (e) {
                App.notify(e?.message || 'Ошибка изменения маршрута', 'error');
            }
            return;
        }

        try {
            const resp = await API.channelDirections.get(directionId);
            const dir = resp?.data || resp || {};
            const channels = Array.isArray(dir.channels) ? dir.channels : [];
            if (!channels.length) {
                App.notify('У направления нет каналов', 'warning');
                return;
            }
            this.relocateDuctCablePendingDirection = { directionId, channels };
            const content = `
                <div style="max-height: 60vh; overflow:auto;">
                    ${(channels || []).map((ch) => `
                        <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="MapManager.selectRelocateDuctCableChannel(${parseInt(ch.id, 10)})">
                            Канал ${ch.channel_number}${ch.kind_name ? ` — ${String(ch.kind_name).replace(/</g, '&lt;')}` : ''}
                        </button>
                    `).join('')}
                </div>
                <p class="text-muted" style="margin-top:8px;">Выберите канал, который нужно добавить в маршрут кабеля.</p>
            `;
            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            App.showModal('Добавить канал в маршрут', content, footer);
        } catch (_) {
            App.notify('Не удалось загрузить каналы направления', 'error');
        }
    },

    async _relocateAddChannel(channelId) {
        if (!this.relocateDuctCableMode || !this.relocateDuctCableId) return;
        const kept = (this.relocateDuctCableRouteChannels || []).slice().sort((a, b) => (a.route_order || 0) - (b.route_order || 0));
        const ids = kept.map(x => x.cable_channel_id);
        if (ids.includes(channelId)) {
            App.notify('Канал уже в маршруте', 'info');
            return;
        }
        ids.push(channelId);
        try {
            const resp = await API.unifiedCables.update(this.relocateDuctCableId, { route_channels: ids });
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const r = await API.unifiedCables.get(this.relocateDuctCableId);
            const c = r?.data || r || {};
            const rcs = Array.isArray(c.route_channels) ? c.route_channels : [];
            this.relocateDuctCableRouteChannels = (rcs || []).map(rc => ({
                cable_channel_id: parseInt(rc?.cable_channel_id || 0, 10),
                direction_id: parseInt(rc?.direction_id || 0, 10),
                route_order: parseInt(rc?.route_order || 0, 10) || 0,
            })).filter(x => x.cable_channel_id > 0 && x.direction_id > 0);
            try { this.highlightCableRouteDirections(this.relocateDuctCableId); } catch (_) {}
            // Обновляем слой duct-кабелей, чтобы геометрия/длина на карте были актуальны
            try { await this.loadCables('duct'); } catch (_) {}
            App.notify('Канал добавлен в маршрут', 'success');
        } catch (e) {
            App.notify(e?.message || 'Ошибка изменения маршрута', 'error');
        }
    },

    toggleRelocateDuctCableMode() {
        this.relocateDuctCableMode = !this.relocateDuctCableMode;
        if (this.relocateDuctCableMode) {
            this.relocateDuctCableId = null;
            this.relocateDuctCableRouteChannels = [];
            this.relocateDuctCablePickCandidates = [];
            this.relocateDuctCableDirectionPickCandidates = [];
            this.relocateDuctCablePendingDirection = null;
            if (this.map) this.map.getContainer().style.cursor = 'crosshair';
            App.notify('Переложить кабель: сначала кликните по кабелю в канализации', 'info');
        } else {
            this.relocateDuctCableId = null;
            this.relocateDuctCableRouteChannels = [];
            this.relocateDuctCablePickCandidates = [];
            this.relocateDuctCableDirectionPickCandidates = [];
            this.relocateDuctCablePendingDirection = null;
            if (this.map) this.map.getContainer().style.cursor = '';
            try { this.clearHighlight(); } catch (_) {}
            try { App.notify('Переложить кабель: режим выключен', 'info'); } catch (_) {}
        }
    },

    toggleMovePointMode() {
        // Если режим уже активен и объект выбран — кнопка работает как "сохранить"
        if (this.movePointMode && this.movePointSelected) {
            this.commitMovePoint();
            return;
        }

        this.movePointMode = !this.movePointMode;
        if (this.movePointMode) {
            this.movePointSelected = null;
            try { if (this.movePointMarker) this.map.removeLayer(this.movePointMarker); } catch (_) {}
            this.movePointMarker = null;
            this.movePointPickCandidates = [];
            if (this.map) this.map.getContainer().style.cursor = 'crosshair';
            App.notify('Перемещение: кликните по колодцу/столбику, затем перетащите и подтвердите Enter', 'info');
        } else {
            this.cancelMovePointMode();
        }
    },

    cancelMovePointMode(opts = null) {
        this.movePointMode = false;
        this.movePointSelected = null;
        this.movePointPickCandidates = [];
        try { if (this.movePointMarker) this.map.removeLayer(this.movePointMarker); } catch (_) {}
        this.movePointMarker = null;
        if (this.map) this.map.getContainer().style.cursor = '';
        try {
            const o = opts || {};
            if (o.notify !== false) App.notify('Режим перемещения отменён', 'info');
        } catch (_) {}
    },

    async commitMovePoint() {
        if (!this.movePointMode || !this.movePointSelected) return;
        const sel = this.movePointSelected;
        const ll = sel.newLatLng || sel.origLatLng;
        const lat = ll?.lat;
        const lng = ll?.lng;
        if (lat === undefined || lng === undefined) return;
        if (typeof App !== 'undefined' && typeof App.canWrite === 'function' && !App.canWrite()) {
            App.notify('Недостаточно прав для изменения', 'error');
            return;
        }
        try {
            let resp = null;
            if (sel.objectType === 'well') {
                resp = await API.wells.update(sel.id, { latitude: lat, longitude: lng });
            } else if (sel.objectType === 'marker_post') {
                resp = await API.markerPosts.update(sel.id, { latitude: lat, longitude: lng });
            }
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.cancelMovePointMode({ notify: false });
            try { document.getElementById('btn-move-point-map')?.classList?.toggle('active', false); } catch (_) {}
            App.notify('Объект перемещён', 'success');
            try { await this.loadAllLayers?.(); } catch (_) {}
        } catch (e) {
            App.notify(e?.message || 'Ошибка перемещения', 'error');
        }
    },

    toggleStuffWellMode() {
        this.stuffWellMode = !this.stuffWellMode;
        if (this.stuffWellMode) {
            if (this.map) this.map.getContainer().style.cursor = 'crosshair';
            App.notify('Кликните по направлению на карте, чтобы набить колодец', 'info');
        } else {
            if (this.map) this.map.getContainer().style.cursor = '';
            try { App.notify('Режим "Набить колодец" выключен', 'info'); } catch (_) {}
        }
    },

    selectObjectForMultiFromHits(idx) {
        const h = (this.lastClickHits || [])[idx];
        if (!h) return;
        App.hideModal();
        this.toggleMultiSelection(h);
    },

    selectObjectFromHits(idx) {
        const h = (this.lastClickHits || [])[idx];
        if (!h) return;
        App.hideModal();
        this.showObjectInfo(h.objectType, h.properties);
    },

    selectIncidentObjectFromHits(idx) {
        const h = (this.lastClickHits || [])[idx];
        if (!h) return;
        this.incidentSelectMode = false;
        App.hideModal();
        App.addIncidentRelatedObjectFromMap(h);
    },

    selectGroupObjectFromHits(idx) {
        const h = (this.lastClickHits || [])[idx];
        if (!h) return;
        const gid = this.groupPickGroupId;
        this.groupPickMode = false;
        this.groupPickGroupId = null;
        if (this.map) this.map.getContainer().style.cursor = '';
        App.hideModal();
        App.addGroupObjectFromMap(gid, h);
    },

    getObjectsAtLatLng(latlng) {
        if (!this.map) return [];
        const clickPt = this.map.latLngToLayerPoint(latlng);
        const hits = [];

        const distToSeg = (p, a, b) => {
            const vx = b.x - a.x, vy = b.y - a.y;
            const wx = p.x - a.x, wy = p.y - a.y;
            const c1 = vx * wx + vy * wy;
            if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
            const c2 = vx * vx + vy * vy;
            if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
            const t = c1 / c2;
            const px = a.x + t * vx, py = a.y + t * vy;
            return Math.hypot(p.x - px, p.y - py);
        };

        const testLayer = (layer) => {
            const meta = layer?._igsMeta;
            if (!meta || !meta.properties) return;
            const props = meta.properties;

            // Point-like
            if (typeof layer.getLatLng === 'function') {
                const pt = this.map.latLngToLayerPoint(layer.getLatLng());
                const d = Math.hypot(clickPt.x - pt.x, clickPt.y - pt.y);
                const thr = 18;
                if (d <= thr) {
                    hits.push({
                        objectType: meta.objectType,
                        properties: props,
                        title: `${this.getTypeDisplayName(meta.objectType)}: ${props.number || props.id}`
                    });
                }
                return;
            }

            // Polyline-like
            if (typeof layer.getLatLngs === 'function') {
                const latlngs = layer.getLatLngs().flat(Infinity).filter(ll => ll && ll.lat !== undefined);
                if (latlngs.length < 2) return;
                const pts = latlngs.map(ll => this.map.latLngToLayerPoint(ll));
                let minD = Infinity;
                for (let i = 0; i < pts.length - 1; i++) {
                    minD = Math.min(minD, distToSeg(clickPt, pts[i], pts[i + 1]));
                }
                if (minD <= 12) {
                    hits.push({
                        objectType: meta.objectType,
                        properties: props,
                        title: `${this.getTypeDisplayName(meta.objectType)}: ${props.number || props.id}`
                    });
                }
            }
        };

        const traverse = (layer) => {
            if (!layer) return;
            if (typeof layer.getLayers === 'function') {
                layer.getLayers().forEach(traverse);
                return;
            }
            testLayer(layer);
        };
        Object.values(this.layers || {}).forEach(group => traverse(group));

        // Убираем дубликаты по (type,id)
        const uniq = new Map();
        hits.forEach(h => {
            const key = `${h.objectType}:${h.properties?.id}`;
            if (!uniq.has(key)) uniq.set(key, h);
        });
        return Array.from(uniq.values());
    },

    updateHoverSnap(latlng) {
        if (!this.map) return;
        // Не мешаем режимам добавления
        if (this.rulerMode || this.addDirectionMode || this.addingObject || this.addCableMode || this.addDuctCableMode) return;

        const hits = this.getObjectsAtLatLng(latlng);
        const container = this.map.getContainer();
        if (hits.length > 0) {
            container.style.cursor = 'pointer';
        } else if (container.style.cursor === 'pointer') {
            container.style.cursor = '';
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
                if (layerName === 'wells') {
                    // подписи колодцев/координат зависят от видимости слоя колодцев
                    try {
                        if (this.wellLabelsEnabled) this.rebuildWellLabelsFromWellsLayer();
                        if (this.objectCoordinatesLabelsEnabled) this.rebuildObjectCoordinatesLabelsFromPointLayers();
                        this.updateWellLabelsVisibility();
                        this.updateObjectCoordinatesLabelsVisibility();
                    } catch (_) {}
                }
                if (layerName === 'channels') {
                    // подписи длины зависят от видимости слоя направлений
                    try {
                        if (this.directionLengthLabelsEnabled) {
                            this.rebuildDirectionLengthLabelsFromDirectionsLayer();
                            this.setDirectionLengthLabelsEnabled(true);
                        }
                    } catch (_) {}
                }
                if (layerName === 'inventory') {
                    try {
                        if (this.inventoryLabelsLayer && this.inventoryUnaccountedLabelsEnabled) {
                            this.map.addLayer(this.inventoryLabelsLayer);
                        }
                    } catch (_) {}
                    // при включении слоя инвентаризации — загружаем его содержимое
                    this.loadInventoryLayer?.();
                }
                if (layerName === 'assumedCables') {
                    // при включении слоя предполагаемых кабелей — загружаем его содержимое
                    this.loadAssumedCablesLayer?.();
                }
            } else {
                this.map.removeLayer(layer);
                if (layerName === 'wells') {
                    try { this.wellLabelsLayer?.clearLayers?.(); } catch (_) {}
                    try { this.objectCoordinatesLabelsLayer?.clearLayers?.(); } catch (_) {}
                    try { this.updateWellLabelsVisibility(); } catch (_) {}
                    try { this.updateObjectCoordinatesLabelsVisibility(); } catch (_) {}
                }
                if (layerName === 'channels') {
                    try { this.directionLengthLabelsLayer?.clearLayers?.(); } catch (_) {}
                    try { this.setDirectionLengthLabelsEnabled(this.directionLengthLabelsEnabled); } catch (_) {}
                }
                if (layerName === 'inventory') {
                    try { this.layers.inventory?.clearLayers?.(); } catch (_) {}
                    try { this.inventoryLabelsLayer?.clearLayers?.(); } catch (_) {}
                    try { if (this.inventoryLabelsLayer) this.map.removeLayer(this.inventoryLabelsLayer); } catch (_) {}
                }
                if (layerName === 'assumedCables') {
                    try { this.layers.assumedCables?.clearLayers?.(); } catch (_) {}
                }
            }
        }
    },

    /**
     * Применение фильтров
     */
    setFilters(filters) {
        this.groupMode = false;
        this.activeGroupId = null;
        this.filters = filters;
        this.loadAllLayers();
    },

    /**
     * Сброс фильтров
     */
    clearFilters() {
        this.groupMode = false;
        this.activeGroupId = null;
        this.filters = {};
        this.loadAllLayers();
    },

    /**
     * Показ информации об объекте
     */
    showObjectInfo(objectType, properties) {
        // Если был включён множественный выбор — сбрасываем его при обычном выборе объекта
        if (this.multiSelected && this.multiSelected.size) {
            this.clearMultiSelection();
        }
        // Подсветка выбранного объекта (тень)
        this.highlightSelectedObject(objectType, properties?.id);
        // Для кабеля дополнительно подсвечиваем линию, как в сценарии "кабели в направлении"
        if (objectType === 'unified_cable' && properties?.id) {
            this.highlightCableGeometryFromLayer(properties.id);
        }

        const infoPanel = document.getElementById('object-info-panel');
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        
        infoTitle.textContent = `${this.getTypeDisplayName(objectType)}: ${properties.number || properties.id}`;
        
        // Формируем содержимое
        let html = '';
        
        const fields = {
            number: 'Номер',
            type_name: 'Вид',
            kind_name: 'Тип',
            status_name: 'Состояние',
            owner_name: 'Собственник',
            fiber_count: 'Кол-во волокон',
            cable_type_name: 'Тип кабеля',
            object_type_name: 'Вид объекта',
            marking: 'Кабель (из каталога)',
            length_calculated: 'Длина расч. (м)',
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

        // ТУ (подгружаем асинхронно)
        html += `<div class="info-row">
            <span class="info-label">ТУ:</span>
            <span class="info-value" id="info-groups">Загрузка...</span>
        </div>`;

        // Доп. действия для карты
        if (objectType === 'well') {
            const canWrite = (typeof App !== 'undefined' && typeof App.canWrite === 'function' && App.canWrite());
            const invId = parseInt(properties?.last_inventory_card_id || 0, 10);
            html += `<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
                <button type="button" class="btn btn-sm btn-secondary" onclick="App.showCablesInWell(${properties.id})">
                    Показать кабели в колодце
                </button>
                ${invId > 0 ? `
                    <button type="button" class="btn btn-sm btn-secondary" onclick="App.openInventoryCard(${invId})">
                        Показать инвентарную карточку
                    </button>
                ` : ``}
                ${canWrite ? `
                    <button type="button" class="btn btn-sm btn-danger" onclick="App.dismantleWell(${properties.id})" title="Демонтаж возможен только если у колодца ровно 2 направления">
                        Демонтаж колодца
                    </button>
                ` : ``}
            </div>`;
        }
        if (objectType === 'channel_direction') {
            const canIncrease = (typeof App !== 'undefined' && typeof App.canWrite === 'function' && App.canWrite());
            html += `<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
                <button type="button" class="btn btn-sm btn-secondary" onclick="App.showCablesInDirection(${properties.id})">
                    Показать кабели в направлении
                </button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="App.showChannelsInDirection(${properties.id})">
                    Показать каналы направления
                </button>
                ${canIncrease ? `
                    <button type="button" class="btn btn-sm btn-primary" onclick="App.increaseDirectionChannels(${properties.id}, ${properties.channels || 0})">
                        Увеличить кол-во каналов
                    </button>
                ` : ``}
            </div>`;
        }

        infoContent.innerHTML = html;
        
        // Сохраняем данные для редактирования
        infoPanel.dataset.objectType = objectType;
        infoPanel.dataset.objectId = properties.id;
        infoPanel.dataset.lat = properties?._lat ?? '';
        infoPanel.dataset.lng = properties?._lng ?? '';

        // Кнопка "Скопировать координаты" доступна только для колодца
        const copyBtn = document.getElementById('btn-copy-coords');
        if (copyBtn) {
            const canCopy = objectType === 'well' && properties?._lat !== undefined && properties?._lng !== undefined;
            copyBtn.classList.toggle('hidden', !canCopy);
        }
        
        infoPanel.classList.remove('hidden');

        // Загружаем группы (после того как panel.dataset заполнен)
        setTimeout(() => {
            try {
                if (typeof App !== 'undefined' && typeof App.loadObjectGroupsIntoInfo === 'function') {
                    App.loadObjectGroupsIntoInfo(objectType, properties.id);
                }
            } catch (_) {}
        }, 0);
    },

    findLayerByMeta(objectType, objectId) {
        if (!this.layers || objectId === undefined || objectId === null) return null;
        let found = null;
        const targetId = String(objectId);

        const testLayer = (layer) => {
            if (found) return;
            const meta = layer?._igsMeta;
            if (!meta || !meta.properties) return;
            if (meta.objectType !== objectType) return;
            const id = meta.properties?.id;
            if (id === undefined || id === null) return;
            if (String(id) === targetId) {
                found = layer;
            }
        };

        const traverse = (layer) => {
            if (!layer || found) return;
            if (typeof layer.getLayers === 'function') {
                layer.getLayers().forEach(traverse);
                return;
            }
            testLayer(layer);
        };

        Object.values(this.layers).forEach(group => traverse(group));
        return found;
    },

    applySelectedShadow(layer, enabled) {
        const el = layer?._path || layer?._icon;
        if (!el) return;
        if (enabled) {
            el.classList.add('igs-selected-shadow');
        } else {
            el.classList.remove('igs-selected-shadow');
        }
    },

    setSelectedLayer(layer) {
        if (this.selectedLayer) {
            this.applySelectedShadow(this.selectedLayer, false);
        }
        this.selectedLayer = layer || null;
        if (this.selectedLayer) {
            this.applySelectedShadow(this.selectedLayer, true);
        }
    },

    highlightSelectedObject(objectType, objectId) {
        const layer = this.findLayerByMeta(objectType, objectId);
        this.setSelectedLayer(layer);
    },

    clearSelectedObject() {
        this.setSelectedLayer(null);
    },

    multiSelectKey(h) {
        return `${h?.objectType}:${h?.properties?.id}`;
    },

    clearMultiSelection() {
        try {
            for (const [k, v] of (this.multiSelected || new Map()).entries()) {
                const layer = this.findLayerByMeta(v?.objectType, v?.properties?.id);
                if (layer) this.applySelectedShadow(layer, false);
            }
        } catch (_) {}
        this.multiSelected = new Map();
        this.hideMultiSelectionInfo();
        try { document.getElementById('object-info-panel')?.classList.add('hidden'); } catch (_) {}
    },

    removeFromMultiSelection(objectType, objectId) {
        const ot = (objectType || '').toString();
        const id = (objectId !== undefined && objectId !== null) ? String(objectId) : '';
        if (!ot || !id) return;
        if (!(this.multiSelected instanceof Map)) this.multiSelected = new Map();
        const key = `${ot}:${id}`;
        if (!this.multiSelected.has(key)) return;

        this.multiSelected.delete(key);
        try {
            const layer = this.findLayerByMeta(ot, id);
            if (layer) this.applySelectedShadow(layer, false);
        } catch (_) {}

        if ((this.multiSelected.size || 0) === 0) {
            this.hideMultiSelectionInfo();
            try { document.getElementById('object-info-panel')?.classList.add('hidden'); } catch (_) {}
            return;
        }
        this.showMultiSelectionInfo();
    },

    toggleMultiSelection(hit) {
        if (!hit || !hit.objectType || !hit.properties?.id) return;
        const key = this.multiSelectKey(hit);

        // При первом Ctrl+клике — снимаем одиночное выделение
        this.clearSelectedObject();

        const exists = this.multiSelected?.has?.(key);
        if (exists) {
            this.multiSelected.delete(key);
            const layer = this.findLayerByMeta(hit.objectType, hit.properties.id);
            if (layer) this.applySelectedShadow(layer, false);
        } else {
            if (!(this.multiSelected instanceof Map)) this.multiSelected = new Map();
            this.multiSelected.set(key, { objectType: hit.objectType, properties: hit.properties });
            const layer = this.findLayerByMeta(hit.objectType, hit.properties.id);
            if (layer) this.applySelectedShadow(layer, true);
        }

        // если ничего не осталось — закрываем панель
        if ((this.multiSelected?.size || 0) === 0) {
            this.hideMultiSelectionInfo();
            return;
        }
        this.showMultiSelectionInfo();
    },

    getMultiSelectedList() {
        try {
            return Array.from((this.multiSelected || new Map()).values());
        } catch (_) {
            return [];
        }
    },

    showMultiSelectionInfo() {
        const infoPanel = document.getElementById('object-info-panel');
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        if (!infoPanel || !infoTitle || !infoContent) return;

        const list = this.getMultiSelectedList();
        infoTitle.textContent = `Выбрано объектов: ${list.length}`;

        const rows = list.slice(0, 50).map((x) => {
            const ot = x.objectType;
            const p = x.properties || {};
            const id = (p.id ?? '');
            const label = String(p.number || p.id || '').replace(/</g, '&lt;');
            return `<div class="info-row" style="display:flex; align-items:center; gap:8px;">
                <span class="info-label" style="flex: 0 0 auto;">${this.getTypeDisplayName(ot)}:</span>
                <span class="info-value" style="flex: 1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis;">${label}</span>
                <button type="button" class="btn btn-sm btn-secondary" style="padding: 2px 8px;" title="Исключить из выделения"
                        onclick='MapManager.removeFromMultiSelection(${JSON.stringify(String(ot))}, ${JSON.stringify(String(id))})'>
                    <i class="fas fa-times"></i>
                </button>
            </div>`;
        }).join('');

        const canBulkEdit = (typeof App !== 'undefined' && typeof App.canWrite === 'function' && App.canWrite());
        const canBulkDelete = (typeof App !== 'undefined' && typeof App.canDelete === 'function' && App.canDelete());
        infoContent.innerHTML = `
            <div class="text-muted" style="margin-bottom:8px;">Ctrl+клик — добавить/убрать объект из выделения.</div>
            ${rows}
            ${list.length > 50 ? `<div class="text-muted" style="margin-top:8px;">... и ещё ${list.length - 50}</div>` : ``}
            <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
                ${canBulkEdit ? `
                    <button type="button" class="btn btn-sm btn-primary" onclick="App.showMapBulkEditModal()">
                        <i class="fas fa-pen"></i> Изменить выбранные
                    </button>
                ` : ``}
                ${canBulkDelete ? `
                    <button type="button" class="btn btn-sm btn-danger" onclick="App.deleteMapMultiSelected()">
                        <i class="fas fa-trash"></i> Удалить выбранные
                    </button>
                ` : ``}
                <button type="button" class="btn btn-sm btn-danger" onclick="MapManager.clearMultiSelection()">
                    <i class="fas fa-times"></i> Снять выделение
                </button>
            </div>
        `;

        // прячем стандартные кнопки (редактировать/удалить) для мультивыбора
        document.getElementById('btn-edit-object')?.classList.add('hidden');
        document.getElementById('btn-delete-object')?.classList.add('hidden');
        document.getElementById('btn-copy-coords')?.classList.add('hidden');
        infoPanel.classList.remove('hidden');
    },

    hideMultiSelectionInfo() {
        // возвращаем стандартные кнопки (в showObjectInfo они выставятся корректно)
        document.getElementById('btn-edit-object')?.classList.remove('hidden');
        document.getElementById('btn-delete-object')?.classList.remove('hidden');
        // copy coords зависит от типа — пусть управляется showObjectInfo
        try {
            const panel = document.getElementById('object-info-panel');
            const type = panel?.dataset?.objectType || '';
            if (type !== 'well') document.getElementById('btn-copy-coords')?.classList.add('hidden');
        } catch (_) {}
    },

    clearHighlight() {
        if (this.highlightLayer) {
            this.map.removeLayer(this.highlightLayer);
            this.highlightLayer = null;
        }
        this.setHighlightBarVisible(false);
    },

    highlightFeatureCollection(fc) {
        try {
            this.clearHighlight();
            if (!fc || fc.type !== 'FeatureCollection') return;
            this.highlightLayer = L.geoJSON(fc, {
                interactive: false,
                pane: 'highlightPane',
                style: () => ({ color: '#ff0000', weight: 5, opacity: 0.95, className: 'cable-highlight-path' })
            }).addTo(this.map);
            this.setHighlightBarVisible(true);
        } catch (e) {
            console.error('Ошибка подсветки (FeatureCollection):', e);
        }
    },

    highlightCableGeometryFromLayer(cableId) {
        try {
            this.clearHighlight();
            const layer = this.findLayerByMeta('unified_cable', cableId);
            const latlngs = layer?.getLatLngs?.();
            if (!latlngs) return;
            this.highlightLayer = L.polyline(latlngs, { interactive: false, pane: 'highlightPane', color: '#ff0000', weight: 5, opacity: 0.95, className: 'cable-highlight-path' }).addTo(this.map);
            this.setHighlightBarVisible(true);
            const bounds = this.highlightLayer.getBounds();
            if (bounds && bounds.isValid()) {
                this.fitToBounds(bounds, 17);
            }
        } catch (e) {
            console.error('Ошибка подсветки кабеля:', e);
        }
    },

    highlightCableGeometryByGeoJson(geometry) {
        try {
            this.clearHighlight();
            if (!geometry) return;
            this.highlightLayer = L.geoJSON(
                { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] },
                { interactive: false, pane: 'highlightPane', style: () => ({ color: '#ff0000', weight: 5, opacity: 0.95, className: 'cable-highlight-path' }) }
            ).addTo(this.map);
            this.setHighlightBarVisible(true);
            const bounds = this.highlightLayer.getBounds();
            if (bounds && bounds.isValid()) {
                this.fitToBounds(bounds, 17);
            }
        } catch (e) {
            console.error('Ошибка подсветки кабеля (geojson):', e);
        }
    },

    async highlightCableRouteDirections(cableId) {
        try {
            this.clearHighlight();
            const resp = await API.unifiedCables.routeDirectionsGeojson(cableId);
            if (resp && resp.type === 'FeatureCollection') {
                this.highlightLayer = L.geoJSON(resp, {
                    interactive: false,
                    style: () => ({ color: '#ff0000', weight: 5, opacity: 0.95, className: 'cable-highlight-path' })
                }).addTo(this.map);
                this.setHighlightBarVisible(true);
                const bounds = this.highlightLayer.getBounds();
                if (bounds && bounds.isValid()) {
                    this.fitToBounds(bounds, 17);
                }
            }
        } catch (e) {
            console.error('Ошибка подсветки маршрута кабеля:', e);
            App.notify('Ошибка подсветки маршрута', 'error');
        }
    },

    /**
     * Скрытие панели информации
     */
    hideObjectInfo() {
        document.getElementById('object-info-panel').classList.add('hidden');
        this.clearSelectedObject();
    },

    /**
     * Обновление координат курсора
     */
    updateCursorCoordinates(e) {
        const lat = e.latlng.lat.toFixed(6);
        const lng = e.latlng.lng.toFixed(6);
        
        document.getElementById('coords-wgs84').textContent = `WGS84: ${lat}, ${lng}`;
    },

    /**
     * Клик по карте (для добавления объектов)
     */
    onMapClick(e) {
        if (this._suppressClickOnce) {
            this._suppressClickOnce = false;
            return;
        }
        if (this.rulerMode) {
            try { this.addRulerPoint(e.latlng); } catch (_) {}
            return;
        }
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

        // Подсвечиваем кнопку инструмента
        try {
            const btnId = (typeCode === 'cable_aerial') ? 'btn-add-aerial-cable-map' : 'btn-add-ground-cable-map';
            document.getElementById(btnId)?.classList?.add('active');
        } catch (_) {}

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
    cancelAddCableMode(opts = null) {
        if (!this.addCableMode) return;
        this.addCableMode = false;
        this.addCableTypeCode = null;
        this.selectedCablePoints = [];
        this.map.getContainer().style.cursor = '';

        // Снимаем подсветку кнопок
        try {
            document.getElementById('btn-add-ground-cable-map')?.classList?.remove('active');
            document.getElementById('btn-add-aerial-cable-map')?.classList?.remove('active');
        } catch (_) {}

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
        try {
            const o = opts || {};
            if (o.notify !== false) App.notify('Режим добавления кабеля отменён', 'info');
        } catch (_) {}
    },

    startAddDuctCableMode() {
        this.addDuctCableMode = true;
        this.selectedDuctCableChannels = [];
        this.map.getContainer().style.cursor = 'crosshair';

        // Подсвечиваем кнопку инструмента
        try { document.getElementById('btn-add-duct-cable-map')?.classList?.add('active'); } catch (_) {}

        const statusEl = document.getElementById('add-mode-status');
        const textEl = document.getElementById('add-mode-text');
        const finishBtn = document.getElementById('btn-finish-add-mode');
        statusEl.classList.remove('hidden');
        if (finishBtn) finishBtn.classList.remove('hidden');
        textEl.textContent = 'Кликните на направлениях и выберите каналы. Затем нажмите «Создать»';

        App.notify('Режим добавления кабеля в канализации: выберите каналы', 'info');
    },

    cancelAddDuctCableMode(opts = null) {
        if (!this.addDuctCableMode) return;
        this.addDuctCableMode = false;
        this.selectedDuctCableChannels = [];
        this.map.getContainer().style.cursor = '';

        try { document.getElementById('btn-add-duct-cable-map')?.classList?.remove('active'); } catch (_) {}

        const finishBtn = document.getElementById('btn-finish-add-mode');
        if (finishBtn) finishBtn.classList.add('hidden');

        if (!this.addDirectionMode && !this.addingObject && !this.addCableMode) {
            document.getElementById('add-mode-status').classList.add('hidden');
        }
        try {
            const o = opts || {};
            if (o.notify !== false) App.notify('Режим добавления кабеля в канализации отменён', 'info');
        } catch (_) {}
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
        try {
            const btnId = (type === 'markers') ? 'btn-add-marker-map' : 'btn-add-well-map';
            document.getElementById(btnId)?.classList?.add('active');
        } catch (_) {}
        App.notify('Кликните на карте для указания местоположения', 'info');
    },

    /**
     * Обработка клика при добавлении объекта
     */
    handleAddObjectClick(latlng) {
        const type = this.addingObject;
        this.addingObject = null;
        this.map.getContainer().style.cursor = '';
        try {
            document.getElementById('btn-add-well-map')?.classList?.remove('active');
            document.getElementById('btn-add-marker-map')?.classList?.remove('active');
        } catch (_) {}
        
        // Открываем модальное окно с заполненными координатами
        App.showAddObjectModal(type, latlng.lat, latlng.lng);
    },

    /**
     * Отмена добавления объекта
     */
    cancelAddingObject() {
        this.addingObject = null;
        this.map.getContainer().style.cursor = '';
        try {
            document.getElementById('btn-add-well-map')?.classList?.remove('active');
            document.getElementById('btn-add-marker-map')?.classList?.remove('active');
        } catch (_) {}
        try { App.notify('Режим добавления объекта отменён', 'info'); } catch (_) {}
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
                    const bounds = typeof layer.getBounds === 'function' ? layer.getBounds() : null;
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
            let cableGeometry = null;
            let highlightRouteDirections = false;

            const boundsFromGeometry = (geom) => {
                try {
                    if (!geom || !geom.type) return null;
                    const tmp = L.geoJSON({
                        type: 'FeatureCollection',
                        features: [{ type: 'Feature', geometry: geom, properties: {} }],
                    });
                    const b = tmp.getBounds();
                    return (b && b.isValid()) ? b : null;
                } catch (_) {
                    return null;
                }
            };

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
                        bounds = boundsFromGeometry(geom) || bounds;
                        if (bounds) {
                            const c = bounds.getCenter();
                            lat = c.lat;
                            lng = c.lng;
                        }
                    }
                    break;
                    
                case 'unified_cables':
                    response = await API.unifiedCables.get(objectId);
                    if (response.success && response.data) {
                        const rawGeom = response.data.geometry;
                        const geom = typeof rawGeom === 'string' ? JSON.parse(rawGeom) : rawGeom;
                        if (geom && geom.type) {
                            bounds = boundsFromGeometry(geom) || bounds;
                            if (bounds) {
                                const c = bounds.getCenter();
                                lat = c.lat;
                                lng = c.lng;
                            }
                            cableGeometry = geom;
                        } else if (response.data.object_type_code === 'cable_duct') {
                            // Фоллбек: если геометрии нет (маршрут может быть только через направления)
                            try {
                                const route = await API.unifiedCables.routeDirectionsGeojson(objectId);
                                if (route && route.type === 'FeatureCollection') {
                                    const b = L.geoJSON(route).getBounds();
                                    if (b && b.isValid()) {
                                        bounds = b;
                                        const c = bounds.getCenter();
                                        lat = c.lat;
                                        lng = c.lng;
                                        highlightRouteDirections = true;
                                    }
                                }
                            } catch (_) {}
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
                } else if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
                    this.flyToObject(lat, lng, 16);
                } else {
                    App.notify('Не удалось определить координаты объекта', 'warning');
                }
            }, 100);

            // Для кабелей дополнительно делаем подсветку "без фильтров" (поверх слоёв)
            if (objectType === 'unified_cables') {
                if (cableGeometry && cableGeometry.type) {
                    setTimeout(() => this.highlightCableGeometryByGeoJson(cableGeometry), 180);
                } else if (highlightRouteDirections) {
                    setTimeout(() => this.highlightCableRouteDirections(objectId), 180);
                }
            }

        } catch (error) {
            console.error('Ошибка показа объекта на карте:', error);
            App.notify('Ошибка загрузки данных объекта', 'error');
        }
    },

    /**
     * Переключение системы координат
     */
    setCoordinateSystem(system) {
        // В системе используется только WGS84
        this.currentCoordinateSystem = 'wgs84';
        this.baseLayer.addTo(this.map);
    },

    /**
     * Загрузка группы объектов
     * @param {number} groupId ID группы
     * @param {object} additionalFilters Дополнительные фильтры (owner_id, status_id, contract_id)
     */
    async loadGroup(groupId, additionalFilters = {}) {
        try {
            this._lastGroupFilters = additionalFilters || {};
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
            
            this.groupMode = true;
            this.activeGroupId = parseInt(groupId);

            // Очищаем все слои
            for (const layer of Object.values(this.layers)) {
                layer.clearLayers();
            }
            if (this.wellLabelsLayer) this.wellLabelsLayer.clearLayers();
            
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
                const addPoint = (objectType, feature, latlng) => {
                    if (objectType === 'well') {
                        const layer = this.createWellMarker(latlng, feature?.properties || {}).addTo(this.layers.wells);
                        layer._igsMeta = { objectType: 'well', properties: feature.properties };
                        layer.on('click', (e) => {
                            L.DomEvent.stopPropagation(e);
                            this.handleObjectsClick(e);
                        });
                        return;
                    }
                    if (objectType === 'marker_post') {
                        const layer = this.createMarkerPostMarker(latlng, feature?.properties || {}).addTo(this.layers.markers);
                        layer._igsMeta = { objectType: 'marker_post', properties: feature.properties };
                        layer.on('click', (e) => {
                            L.DomEvent.stopPropagation(e);
                            this.handleObjectsClick(e);
                        });
                    }
                };

                const addLine = (layerGroup, objectType, feature, latlngs, style) => {
                    const props = feature?.properties;
                    if (this.ownersLegendEnabled && props?.owner_color) {
                        style = { ...(style || {}), color: props.owner_color };
                    } else if (props?.status_code === 'planned' && props?.status_color) {
                        style = { ...(style || {}), color: props.status_color };
                    } else if (props?.type_color) {
                        // для старых кабелей/направлений в группе используем цвет вида объекта
                        style = { ...(style || {}), color: props.type_color };
                    }
                    const layer = L.polyline(latlngs, style).addTo(layerGroup);
                    layer._igsMeta = { objectType, properties: feature.properties };
                    layer.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        this.handleObjectsClick(e);
                    });
                };

                validFeatures.forEach((f) => {
                    const ot = f?.properties?.object_type;
                    const geom = f?.geometry;
                    if (!ot || !geom) return;

                    if (geom.type === 'Point') {
                        const latlng = L.GeoJSON.coordsToLatLng(geom.coordinates);
                        addPoint(ot, f, latlng);
                        return;
                    }

                    // LineString / MultiLineString
                    const latlngs = L.GeoJSON.coordsToLatLngs(geom.coordinates, geom.type === 'MultiLineString' ? 1 : 0);
                    if (ot === 'channel_direction') {
                        const props = f?.properties || {};
                        const isInbuilding = (props.status_code || '').toString().trim().toLowerCase() === 'inbuilding';
                        addLine(this.layers.channels, 'channel_direction', f, latlngs, {
                            color: this.colors.channels,
                            weight: this.getDirectionLineWeight(),
                            opacity: 0.8,
                            ...(isInbuilding ? { dashArray: '6, 6' } : {}),
                        });
                    } else if (ot === 'ground_cable') {
                        addLine(this.layers.groundCables, 'ground_cable', f, latlngs, { color: this.colors.groundCables, weight: this.getCableLineWeight(), opacity: 0.8 });
                    } else if (ot === 'aerial_cable') {
                        addLine(this.layers.aerialCables, 'aerial_cable', f, latlngs, { color: this.colors.aerialCables, weight: this.getCableLineWeight(), opacity: 0.8, dashArray: '5, 5' });
                    } else if (ot === 'duct_cable') {
                        addLine(this.layers.ductCables, 'duct_cable', f, latlngs, { color: this.colors.ductCables, weight: this.getCableLineWeight(), opacity: 0.8 });
                    }
                });

                if (this.wellLabelsEnabled) this.rebuildWellLabelsFromWellsLayer();
                if (this.ownersLegendEnabled) this.renderOwnersLegend();
                if (this.directionLengthLabelsEnabled) this.rebuildDirectionLengthLabelsFromDirectionsLayer();
                this.updateWellLabelsVisibility();
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
