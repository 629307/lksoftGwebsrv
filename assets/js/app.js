/**
 * Основное приложение ИГС lksoftGwebsrv
 */

const App = {
    user: null,
    currentPanel: 'map',
    currentTab: 'wells',
    currentReference: null,
    // Последний выбранный справочник внутри панели "Справочники"
    // (нужно, чтобы переход в "Контракты" не ломал редактирование справочников)
    lastReferenceInReferencesPanel: null,
    settings: {},
    pagination: { page: 1, limit: 50, total: 0 },
    objectsOrder: 'asc', // A-Z по умолчанию
    incidentDraftRelatedObjects: [],
    selectedObjectIds: new Set(),
    _contractsPanelLoaded: false,
    _mapDefaultsCache: null,
    _layerPrefsSaveTimer: null,
    _suppressLayerPrefSave: false,
    assumedCablesModeEnabled: false, // режим "Предполагаемые кабели" внутри слоя "Инвентаризация"

    // ТУ режим (на карте): создаваемые объекты -> planned + автопривязка к выбранному ТУ
    tuModeEnabled: false,
    tuModeGroupId: null,
    _tuListCache: null,
    _tuListSelectedId: null,
    _tuListSearch: '',
    _returnToTuListAfterCreate: false,

    /**
     * Инициализация приложения
     */
    async init() {
        // Проверяем авторизацию
        const token = API.getToken();
        
        if (token) {
            try {
                const response = await API.auth.me();
                if (response.success) {
                    this.user = response.data;
                    this.showApp();
                } else {
                    this.showLogin();
                }
            } catch (error) {
                this.showLogin();
            }
        } else {
            this.showLogin();
        }

        this.bindEvents();
    },

    /**
     * Показ экрана авторизации
     */
    showLogin() {
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
    },

    /**
     * Показ основного приложения
     */
    async showApp() {
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');

        // Отображаем имя пользователя
        const userNameEl = document.getElementById('user-name');
        if (userNameEl) {
            userNameEl.textContent = this.user.full_name || this.user.login;
            userNameEl.style.cursor = 'pointer';
            userNameEl.title = 'Права и доступные функции';
            if (!this._boundUserNameClick) {
                this._boundUserNameClick = true;
                userNameEl.addEventListener('click', () => this.showRoleCapabilitiesModal());
            }
        }

        // Скрываем админ-панель для не-админов
        if (this.user.role.code !== 'admin') {
            document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        }

        // Управление справочниками (создание/редактирование/удаление) — только администратор
        if (!this.canManageReferences()) {
            document.getElementById('btn-add-ref')?.classList.add('hidden');
        }

        // Ограничения на запись/удаление (роль "только чтение" и т.п.)
        if (!this.canWrite()) {
            document.getElementById('btn-add-object')?.classList.add('hidden');
            document.getElementById('btn-add-incident')?.classList.add('hidden');
            document.getElementById('btn-import')?.classList.add('hidden');
            document.getElementById('btn-edit-object')?.classList.add('hidden');

            // Инструменты добавления на карте тоже прячем
            ['btn-add-direction-map', 'btn-add-well-map', 'btn-add-marker-map', 'btn-add-ground-cable-map', 'btn-add-aerial-cable-map', 'btn-add-duct-cable-map', 'btn-add-duct-cable-shortest-map', 'btn-inventory-mode']
                .forEach(id => document.getElementById(id)?.classList.add('hidden'));
        }
        if (!this.canDelete()) {
            document.getElementById('btn-delete-object')?.classList.add('hidden');
        }

        // Роль "Только чтение": в меню доступна только карта, в тулбаре карты — только переключатели подписей/легенды
        if ((this.user?.role?.code || '') === 'readonly') {
            // Навигация: оставляем только "Карта"
            document.querySelectorAll('.sidebar-nav .nav-item').forEach((el) => {
                const p = el?.dataset?.panel;
                if (p && p !== 'map') el.classList.add('hidden');
            });
            // Слой/функционал "Инвентаризация" недоступен для роли readonly
            try {
                const invCb = document.getElementById('layer-inventory');
                if (invCb) {
                    invCb.checked = false;
                    invCb.disabled = true;
                    invCb.closest?.('.layer-item')?.classList?.add('hidden');
                }
                // связанные элементы управления слоя
                [
                    'inventory-inline-controls',
                    'btn-toggle-assumed-cables',
                    'assumed-cables-variant',
                    'btn-assumed-cables-rebuild',
                    'btn-inventory-unacc-labels',
                    'btn-inventory-mode',
                    'btn-recalc-inventory-unaccounted',
                    'btn-recalc-well-owner-code-in-number',
                    'btn-recalc-direction-names',
                ].forEach((id) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    el.classList.add('hidden');
                    try { el.disabled = true; } catch (_) {}
                });
                // на всякий случай снимаем слои на карте
                try { MapManager?.toggleLayer?.('inventory', false); } catch (_) {}
                try { MapManager?.toggleLayer?.('assumedCables', false); } catch (_) {}
                try { MapManager?.setAssumedCablesPanelVisible?.(false); } catch (_) {}
                try { MapManager?.setInventoryUnaccountedLabelsEnabled?.(false); } catch (_) {}
            } catch (_) {}
            // Инструменты карты: отключаем всё кроме разрешённых
            try {
                const allowed = new Set([
                    'btn-toggle-well-labels',
                    'btn-toggle-object-coordinates',
                    'btn-toggle-direction-length-labels',
                    'btn-toggle-owner-legend',
                    // безопасная операция (не меняет данные) — разрешаем всем
                    'btn-refresh-map',
                ]);
                document.querySelectorAll('#map-toolbar button').forEach((btn) => {
                    if (!btn?.id) return;
                    if (allowed.has(btn.id)) return;
                    btn.disabled = true;
                    btn.classList.add('disabled');
                    btn.title = 'Недоступно для роли "Только чтение"';
                });
            } catch (_) {}

            // Фильтры: ТУ и Состояние недоступны для роли readonly
            try {
                const dis = (id, title) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    el.disabled = true;
                    el.title = title || 'Недоступно для роли "Только чтение"';
                    try { el.style.background = 'var(--bg-tertiary)'; } catch (_) {}
                    try { el.value = ''; } catch (_) {}
                };
                dis('filter-group', 'Недоступно для роли "Только чтение"');
                dis('filter-status', 'Недоступно для роли "Только чтение"');
            } catch (_) {}
        }

        // Кнопка "Загрузить" доступна только для колодцев + права на запись
        document.getElementById('btn-import')?.classList.toggle('hidden', this.currentTab !== 'wells' || !this.canWrite());

        // Подгружаем настройки до инициализации карты (центр/зум/ссылки)
        await this.loadSettings().catch(() => {});

        // Инициализируем карту
        MapManager.init();

        // Админ: периодическая проверка расписания бэкапов (создаст бэкап только если "пора")
        if (this.isAdmin()) {
            try {
                if (!this._dbBackupTickTimer) {
                    const tick = async () => {
                        try { await API.dbBackups?.tick?.(); } catch (_) {}
                    };
                    // 1 раз при старте
                    tick().catch(() => {});
                    // затем раз в 10 минут (если админ держит вкладку открытой)
                    this._dbBackupTickTimer = setInterval(() => tick().catch(() => {}), 10 * 60 * 1000);
                }
            } catch (_) {}
        }

        // Подтягиваем цвета типов объектов (слои + отрисовка на карте)
        this.refreshObjectTypeColors().catch(() => {});

        // Предполагаемые кабели: вариант (localStorage) + режим (внутри слоя "Инвентаризация")
        try {
            const rawV = localStorage.getItem('igs_assumed_cables_variant');
            const v = parseInt(rawV || '1', 10);
            const vv = [1, 2, 3].includes(v) ? v : 1;
            MapManager.assumedCablesVariantNo = vv;
            const sel = document.getElementById('assumed-cables-variant');
            if (sel) sel.value = String(vv);
        } catch (_) {}
        // по умолчанию: режим "Предполагаемые кабели" выключен
        try { this.assumedCablesModeEnabled = false; } catch (_) {}
        try {
            const btnMode = document.getElementById('btn-toggle-assumed-cables');
            if (btnMode) btnMode.classList.toggle('active', false);
            try {
                const invCb = document.getElementById('layer-inventory');
                if (btnMode) btnMode.disabled = !(invCb?.checked);
            } catch (_) {}
            const sel = document.getElementById('assumed-cables-variant');
            const btn = document.getElementById('btn-assumed-cables-rebuild');
            if (sel) sel.disabled = true;
            if (btn) btn.disabled = true;
            try { MapManager.setAssumedCablesPanelVisible?.(false); } catch (_) {}
        } catch (_) {}
        // при старте: если слой колодцев включен/выключен — disabled кнопок подсказок
        try {
            const cb = document.getElementById('layer-wells');
            const checked = !!cb?.checked;
            document.getElementById('btn-toggle-well-labels') && (document.getElementById('btn-toggle-well-labels').disabled = !checked);
            document.getElementById('btn-toggle-object-coordinates') && (document.getElementById('btn-toggle-object-coordinates').disabled = !checked);
        } catch (_) {}
        // при старте: инвентаризация (кнопка всегда видна, но disabled если слой off)
        try {
            const cb = document.getElementById('layer-inventory');
            const checked = !!cb?.checked;
            const btn = document.getElementById('btn-inventory-unacc-labels');
            if (btn) {
                btn.disabled = !checked;
                btn.classList.toggle('active', checked && !!MapManager.inventoryUnaccountedLabelsEnabled);
            }
        } catch (_) {}
        // при старте: кабели — кнопки "Список" disabled если слой off
        try {
            const sync = (cbId, btnId) => {
                const cb = document.getElementById(cbId);
                const btn = document.getElementById(btnId);
                if (!btn) return;
                const on = !!cb?.checked;
                btn.disabled = !on;
                btn.classList.toggle('active', false);
            };
            sync('layer-ground-cables', 'btn-list-ground-cables');
            sync('layer-aerial-cables', 'btn-list-aerial-cables');
            sync('layer-duct-cables', 'btn-list-duct-cables');
        } catch (_) {}
        // при старте: направления (кнопка всегда видна, но disabled если слой off)
        try {
            const cb = document.getElementById('layer-channels');
            const checked = !!cb?.checked;
            const btn = document.getElementById('btn-toggle-direction-length-labels');
            if (btn) {
                btn.disabled = !checked;
                btn.classList.toggle('active', checked && !!MapManager.directionLengthLabelsEnabled);
            }
        } catch (_) {}

        // Применяем начальную видимость слоёв (с учётом персональных настроек пользователя)
        this._suppressLayerPrefSave = true;
        this.applyLayerPreferencesFromSettings();
        // Инвентаризация по умолчанию всегда выключена (не зависит от персональных настроек слоёв)
        try {
            const inv = document.getElementById('layer-inventory');
            if (inv) inv.checked = false;
            try { MapManager?.toggleLayer?.('inventory', false); } catch (_) {}
            try { MapManager?.toggleLayer?.('assumedCables', false); } catch (_) {}
            try { this.assumedCablesModeEnabled = false; } catch (_) {}
        } catch (_) {}
        document.querySelectorAll('.layer-item input').forEach(input => this.handleLayerToggle(input));
        this._suppressLayerPrefSave = false;

        // Загружаем справочники для фильтров (не блокируем основной поток)
        this.loadFilterOptions().catch(err => console.error('Ошибка загрузки фильтров:', err));

        // Загружаем данные карты
        try {
            await MapManager.loadAllLayers();
        } catch (error) {
            console.error('Ошибка загрузки данных карты:', error);
            this.notify('Ошибка загрузки данных карты', 'error');
        }
    },

    showRoleCapabilitiesModal() {
        const roleCode = (this.user?.role?.code || '').toString();
        const roleName = (this.user?.role?.name || '').toString();
        const title = `Доступные функции (${this.escapeHtml(roleName || roleCode || 'роль')})`;

        const rows = [];
        const add = (h, items) => {
            const list = (items || []).filter(Boolean);
            rows.push(`
                <div style="margin-bottom:12px;">
                    <div style="font-weight:800; margin-bottom:6px;">${this.escapeHtml(h)}</div>
                    <ul style="margin:0; padding-left: 18px; color: var(--text-secondary);">
                        ${list.map(x => `<li>${this.escapeHtml(x)}</li>`).join('')}
                    </ul>
                </div>
            `);
        };

        if (roleCode === 'admin') {
            add('Администратор', [
                'Доступны все разделы и функции системы.',
                'Создание/редактирование/удаление объектов и справочников.',
                'Управление пользователями и системными настройками.',
            ]);
        } else if (roleCode === 'readonly') {
            add('Только чтение', [
                'В меню доступна только “Карта”.',
                'Доступны слои, фильтры и ссылки.',
                'Запрещено создание/редактирование/удаление объектов, инцидентов, контрактов, отчётов, справочников, пользователей и системных настроек.',
            ]);
            add('Панель инструментов карты', [
                'Подсказки (номера колодцев)',
                'Показать координаты',
                'Подсказки длина направления',
                'Легенда по собственникам',
            ]);
        } else {
            // user / другие роли
            add('Пользователь', [
                'Доступны основные функции системы (объекты/карта/инциденты/контракты/отчёты).',
                'Разрешено создание/редактирование/удаление объектов.',
            ]);
            add('Ограничения', [
                'Запрещено редактирование/удаление справочников.',
                'Запрещено создание/удаление/редактирование пользователей.',
                'Запрещено изменение системных настроек (Настройка данных ГИС / Настройка интерфейса карты ГИС / Настройка слоя WMTS).',
                'Разрешены персонализированные настройки.',
            ]);
        }

        const content = `
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${rows.join('')}
            </div>
        `;
        const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
        this.showModal(title, content, footer);
    },

    async loadSettings() {
        try {
            const resp = await API.settings.get();
            if (resp?.success === false) return;
            this.settings = resp?.data || resp || {};
        } catch (e) {
            this.settings = {};
        }

        // Персональная ширина левого сайдбара
        try {
            const fromSettings = (this.settings?.sidebar_width ?? '').toString().trim();
            const fromLocal = (localStorage.getItem('igs_sidebar_width') || '').toString().trim();
            const raw = fromSettings || fromLocal;
            const w = parseInt(raw || '', 10);
            if (Number.isFinite(w) && w >= 220 && w <= 1200) {
                document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
            }
        } catch (_) {}

        // Применяем на MapManager дефолтные центр/зум
        const z = parseInt(this.settings.map_default_zoom, 10);
        const lat = parseFloat(this.settings.map_default_lat);
        const lng = parseFloat(this.settings.map_default_lng);
        if (Number.isFinite(z)) MapManager.defaultZoom = z;
        if (Number.isFinite(lat) && Number.isFinite(lng)) MapManager.defaultCenter = [lat, lng];

        // Применяем цвет подсветки выбранного объекта (CSS var + обновление текущего выделения)
        try {
            const raw = (this.settings.selected_object_highlight_color ?? '').toString().trim();
            const color = raw && /^#[0-9a-f]{6}$/i.test(raw) ? raw : '#ffff00';
            document.documentElement.style.setProperty('--igs-selected-color', color);
            try { MapManager?.setSelectedHaloLayer?.(MapManager?.selectedLayer); } catch (_) {}
        } catch (_) {}

        // Применяем ссылки в сайдбаре
        const g = (this.settings.url_geoproj || '').toString().trim();
        const c = (this.settings.url_cadastre || '').toString().trim();
        const linkGeo = document.getElementById('link-geoproj');
        const linkCad = document.getElementById('link-cadastre');
        if (linkGeo && g) linkGeo.href = g;
        if (linkCad && c) linkCad.href = c;
    },

    /**
     * Слои карты: применить персональные настройки (если есть)
     * Формат settings.map_layers: CSV internal layer names (wells,channels,markers,groundCables,aerialCables,ductCables)
     */
    applyLayerPreferencesFromSettings() {
        const raw = (this.settings?.map_layers ?? '').toString().trim();
        if (!raw) return;

        const enabled = new Set(
            raw.split(',')
                .map(s => (s || '').toString().trim())
                .filter(Boolean)
        );

        const layerToCheckboxId = {
            wells: 'layer-wells',
            channels: 'layer-channels',
            markers: 'layer-markers',
            groundCables: 'layer-ground-cables',
            aerialCables: 'layer-aerial-cables',
            ductCables: 'layer-duct-cables',
        };

        Object.entries(layerToCheckboxId).forEach(([layerName, checkboxId]) => {
            const cb = document.getElementById(checkboxId);
            if (!cb) return;
            cb.checked = enabled.has(layerName);
        });
    },

    /**
     * Слои карты: сериализация текущих чекбоксов в CSV
     */
    serializeLayerPreferences() {
        const layerToCheckboxId = {
            wells: 'layer-wells',
            channels: 'layer-channels',
            markers: 'layer-markers',
            groundCables: 'layer-ground-cables',
            aerialCables: 'layer-aerial-cables',
            ductCables: 'layer-duct-cables',
        };

        const enabled = [];
        Object.entries(layerToCheckboxId).forEach(([layerName, checkboxId]) => {
            const cb = document.getElementById(checkboxId);
            if (cb && cb.checked) enabled.push(layerName);
        });
        return enabled.join(',');
    },

    /**
     * Слои карты: сохранить персональные настройки (debounce)
     */
    saveLayerPreferencesDebounced() {
        if (this._suppressLayerPrefSave) return;
        if (this._layerPrefsSaveTimer) clearTimeout(this._layerPrefsSaveTimer);
        this._layerPrefsSaveTimer = setTimeout(async () => {
            const value = this.serializeLayerPreferences();
            try {
                const resp = await API.settings.update({ map_layers: value });
                if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                this.settings.map_layers = value;
            } catch (_) {
                // ignore
            }
        }, 250);
    },

    /**
     * Привязка событий
     */
    bindEvents() {
        // Форма авторизации
        document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));

        // Выход
        document.getElementById('btn-logout').addEventListener('click', () => this.handleLogout());

        // Навигация
        const closeMobileSidebar = () => {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            if (sidebar) sidebar.classList.remove('open');
            if (overlay) overlay.classList.add('hidden');
        };
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                this.switchPanel(item.dataset.panel);
                closeMobileSidebar();
            });
        });

        // Мобильное меню (сайдбар)
        const mobileMenuBtn = document.getElementById('btn-mobile-menu');
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (mobileMenuBtn && sidebar && overlay) {
            const open = () => {
                sidebar.classList.add('open');
                overlay.classList.remove('hidden');
            };
            const close = () => closeMobileSidebar();
            mobileMenuBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const isOpen = sidebar.classList.contains('open');
                if (isOpen) close();
                else open();
            });
            overlay.addEventListener('click', () => close());
            window.addEventListener('resize', () => {
                if (window.innerWidth > 768) close();
            });
        }

        // Переключение темы
        document.getElementById('btn-theme-dark').addEventListener('click', () => this.setTheme('dark'));
        document.getElementById('btn-theme-grey').addEventListener('click', () => this.setTheme('grey'));

        // Система координат: только WGS84
        document.getElementById('btn-wgs84').addEventListener('click', () => this.setCoordinateSystem('wgs84'));
        // Экспорт карты в PDF (без интерфейса)
        document.getElementById('btn-save-pdf')?.addEventListener('click', (e) => {
            try { e.preventDefault(); } catch (_) {}
            this.saveMapPdf().catch((err) => {
                console.error('PDF export error:', err);
                this.notify(err?.message || 'Не удалось сформировать PDF', 'error');
            });
        });
        // Внешний WMTS слой (кнопка в шапке)
        document.getElementById('btn-toggle-wmts')?.addEventListener('click', async (e) => {
            try {
                MapManager.toggleExternalWmtsLayer();
                e.currentTarget.classList.toggle('active', !!MapManager.wmtsSatelliteEnabled);
            } catch (_) {
                // ignore
            }
        });

        // Порядок отображения слоёв (персональный)
        document.getElementById('btn-layer-order')?.addEventListener('click', (e) => {
            try { e.preventDefault(); } catch (_) {}
            try { this.showLayerOrderModal(); } catch (_) {}
        });

        // Линейка (измерение расстояний)
        document.getElementById('btn-ruler')?.addEventListener('click', (e) => {
            try { e.preventDefault(); } catch (_) {}
            try {
                MapManager.toggleRulerMode?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.rulerMode);
            } catch (_) {}
        });

        // Слои карты
        document.querySelectorAll('.layer-item input').forEach(input => {
            input.addEventListener('change', () => this.handleLayerToggle(input));
        });

        // Слои карты: подсказки инвентаризации (неучтенные)
        document.getElementById('btn-inventory-unacc-labels')?.addEventListener('click', (e) => {
            try {
                e.preventDefault();
                e.stopPropagation();
            } catch (_) {}
            try {
                MapManager.toggleInventoryUnaccountedLabels?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.inventoryUnaccountedLabelsEnabled);
            } catch (_) {}
        });

        // Кабели: кнопки "Список" (в панели слоёв)
        const bindCablesListBtn = (btnId, type) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', (e) => {
                try {
                    e.preventDefault();
                    e.stopPropagation();
                } catch (_) {}
                try { MapManager?.showCablesListPanel?.(type); } catch (_) {}
            });
        };
        bindCablesListBtn('btn-list-ground-cables', 'ground');
        bindCablesListBtn('btn-list-aerial-cables', 'aerial');
        bindCablesListBtn('btn-list-duct-cables', 'duct');

        // Переключатель "Предполагаемые кабели" (режим внутри слоя "Инвентаризация")
        document.getElementById('btn-toggle-assumed-cables')?.addEventListener('click', (e) => {
            try {
                e.preventDefault();
                e.stopPropagation();
            } catch (_) {}
            const next = !this.assumedCablesModeEnabled;
            this.setAssumedCablesModeEnabled(next, { ensureInventoryOn: true });
        });

        // Предполагаемые кабели: выбор варианта (1/2/3) + пересчёт
        const assumedVariant = document.getElementById('assumed-cables-variant');
        if (assumedVariant) {
            assumedVariant.addEventListener('click', (e) => {
                try { e.stopPropagation(); } catch (_) {}
            });
            assumedVariant.addEventListener('change', (e) => {
                try { e.stopPropagation(); } catch (_) {}
                const v = parseInt(e?.target?.value || '1', 10);
                const vv = [1, 2, 3].includes(v) ? v : 1;
                MapManager.assumedCablesVariantNo = vv;
                try { localStorage.setItem('igs_assumed_cables_variant', String(vv)); } catch (_) {}
                try {
                    const invOn = !!document.getElementById('layer-inventory')?.checked;
                    if (invOn && this.assumedCablesModeEnabled) {
                        MapManager.loadAssumedCablesLayer?.();
                        MapManager.refreshAssumedCablesPanel?.();
                    }
                } catch (_) {}
            });
        }
        document.getElementById('btn-assumed-cables-rebuild')?.addEventListener('click', (e) => {
            try {
                e.preventDefault();
                e.stopPropagation();
            } catch (_) {}
            this.rebuildAssumedCables();
        });

        // Ресайз левого сайдбара (drag по кромке у карты)
        this.initSidebarResize?.();

        // Фильтры (авто-применение при выборе)
        ['filter-group', 'filter-owner', 'filter-status', 'filter-contract'].forEach((id) => {
            document.getElementById(id)?.addEventListener('change', () => this.applyFilters());
        });
        document.getElementById('btn-reset-filters').addEventListener('click', () => this.resetFilters());

        // Закрытие панели информации
        document.getElementById('btn-close-info').addEventListener('click', () => MapManager.hideObjectInfo());

        // Табы объектов
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Поиск объектов
        document.getElementById('search-objects').addEventListener('input', (e) => this.handleSearch(e.target.value));

        // Множественный выбор объектов (делегирование событий)
        document.getElementById('objects-table')?.addEventListener('change', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLInputElement)) return;

            if (target.id === 'select-all-objects') {
                const checked = target.checked;
                document.querySelectorAll('#table-body input.obj-select[type="checkbox"]').forEach((cb) => {
                    cb.checked = checked;
                    const id = cb.dataset.id;
                    if (!id) return;
                    if (checked) this.selectedObjectIds.add(id);
                    else this.selectedObjectIds.delete(id);
                });
                this.updateBulkDeleteButton();
                return;
            }

            if (target.classList.contains('obj-select')) {
                const id = target.dataset.id;
                if (!id) return;
                if (target.checked) this.selectedObjectIds.add(id);
                else this.selectedObjectIds.delete(id);

                const all = Array.from(document.querySelectorAll('#table-body input.obj-select[type="checkbox"]'));
                const allChecked = all.length > 0 && all.every(cb => cb.checked);
                const selectAll = document.getElementById('select-all-objects');
                if (selectAll) selectAll.checked = allChecked;

                this.updateBulkDeleteButton();
            }
        });

        // Ctrl + клик по строке таблицы = переключить чекбокс выбора (мультивыбор)
        document.getElementById('table-body')?.addEventListener('click', (e) => {
            try {
                if (!e.ctrlKey) return;
                const t = e.target;
                if (!t) return;
                // не перехватываем клики по кнопкам/инпутам действий
                const tag = String(t.tagName || '').toUpperCase();
                if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A') return;
                if (t.closest && (t.closest('button') || t.closest('a') || t.closest('input'))) return;
                const tr = t.closest ? t.closest('tr[data-id]') : null;
                if (!tr) return;
                const cb = tr.querySelector ? tr.querySelector('input.obj-select[type="checkbox"]') : null;
                if (!cb) return;
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                e.preventDefault();
            } catch (_) {
                // ignore
            }
        });

        // Фильтры для кабелей в списке объектов
        document.getElementById('cables-filter-object-type')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });
        document.getElementById('cables-filter-owner')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });
        document.getElementById('cables-filter-contract')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });

        // Кнопки добавления
        document.getElementById('btn-add-object').addEventListener('click', () => this.showAddObjectModal(this.currentTab));
        document.getElementById('btn-find-clones')?.addEventListener('click', () => this.findWellClones());
        document.getElementById('btn-recalc-inventory-unaccounted')?.addEventListener('click', () => this.recalculateInventoryUnaccounted());
        document.getElementById('btn-recalc-well-owner-code-in-number')?.addEventListener('click', () => this.recalculateWellOwnerCodeInNumber());
        document.getElementById('btn-import').addEventListener('click', () => this.showImportModal());
        document.getElementById('btn-recalc-direction-names')?.addEventListener('click', () => this.recalculateDirectionNames());
        document.getElementById('btn-export').addEventListener('click', () => this.exportObjects());
        document.getElementById('btn-recalc-cable-lengths')?.addEventListener('click', () => this.recalculateCableLengths());
        document.getElementById('btn-delete-selected')?.addEventListener('click', () => this.deleteSelectedObjects());
        document.getElementById('objects-filter-owner')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });
        document.getElementById('wells-filter-has-inventory')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });
        document.getElementById('wells-filter-coords-needs-refine')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });
        document.getElementById('objects-filter-type')?.addEventListener('change', () => {
            this.pagination.page = 1;
            this.loadObjects();
        });

        // Инциденты
        document.getElementById('btn-add-incident').addEventListener('click', () => this.showAddIncidentModal());
        document.getElementById('btn-filter-incidents').addEventListener('click', () => this.loadIncidents());

        // Отчёты
        document.querySelectorAll('.report-card').forEach(card => {
            card.addEventListener('click', () => this.showReport(card.dataset.report));
        });

        // Справочники
        document.querySelectorAll('.reference-card').forEach(card => {
            card.addEventListener('click', () => this.showReference(card.dataset.ref));
        });
        document.getElementById('btn-back-refs').addEventListener('click', () => this.hideReference());
        document.getElementById('btn-add-ref').addEventListener('click', () => this.showAddReferenceModal());

        // Контракты (отдельная панель)
        document.getElementById('btn-add-contract')?.addEventListener('click', () => this.showAddContractModal());

        // Админка
        document.getElementById('btn-add-user').addEventListener('click', () => this.showAddUserModal());

        // Настройки
        document.getElementById('btn-save-settings')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.saveSettings();
        });

        // Модальное окно
        document.getElementById('btn-close-modal').addEventListener('click', () => this.hideModal());

        // Редактирование/удаление объекта
        document.getElementById('btn-edit-object').addEventListener('click', () => this.editCurrentObject());
        document.getElementById('btn-delete-object').addEventListener('click', () => this.deleteCurrentObject());
        document.getElementById('btn-copy-coords')?.addEventListener('click', () => this.copyCurrentObjectCoordinates());

        // Отмена подсветки маршрута кабеля
        document.getElementById('btn-clear-highlight')?.addEventListener('click', () => MapManager.clearHighlight());

        // Esc = отменить подсветку / отменить режимы добавления (аналогично кнопкам "Отменить ...")
        // Delete/Backspace = удалить выбранный объект (как кнопка "Удалить" в панели) / удалить выбранные при мультивыборе
        if (!this._boundEscHighlight) {
            this._boundEscHighlight = true;
            document.addEventListener('keydown', (e) => {
                // Игнорируем горячие клавиши, если курсор в поле ввода
                const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toUpperCase() : '';
                const isEditable =
                    tag === 'INPUT' ||
                    tag === 'TEXTAREA' ||
                    tag === 'SELECT' ||
                    (e.target && e.target.isContentEditable);

                if (e.key === 'Delete' || e.key === 'Backspace') {
                    if (isEditable) return;
                    // если открыта модалка — не удаляем с клавиатуры
                    const modal = document.getElementById('modal');
                    if (modal && !modal.classList.contains('hidden')) return;

                    try {
                        // мультивыбор: удаляем выбранные объекты
                        const mm = (typeof MapManager !== 'undefined') ? MapManager : null;
                        const hasMulti = !!(mm?.multiSelected && (mm.multiSelected.size || 0) > 0);
                        if (hasMulti && this.canDelete()) {
                            e.preventDefault();
                            this.deleteMapMultiSelected();
                            return;
                        }
                    } catch (_) {}

                    // одиночный выбор: удаляем текущий объект (как кнопка "Удалить" в панели)
                    try {
                        const panel = document.getElementById('object-info-panel');
                        const visible = panel && !panel.classList.contains('hidden');
                        const hasObj = !!(panel?.dataset?.objectType && panel?.dataset?.objectId);
                        if (visible && hasObj && this.canDelete()) {
                            e.preventDefault();
                            this.deleteCurrentObject();
                        }
                    } catch (_) {}
                    return;
                }

                if (e.key === 'Enter') {
                    if (isEditable) return;
                    // если открыта модалка — не подтверждаем перемещение
                    const modal = document.getElementById('modal');
                    if (modal && !modal.classList.contains('hidden')) return;
                    try {
                        const mm = (typeof MapManager !== 'undefined') ? MapManager : null;
                        if (mm?.inventoryMode && typeof mm.finishAddCableMode === 'function') {
                            e.preventDefault();
                            mm.finishAddCableMode();
                            return;
                        }
                        if (mm?.movePointMode && typeof mm.commitMovePoint === 'function') {
                            e.preventDefault();
                            mm.commitMovePoint();
                            return;
                        }
                    } catch (_) {}
                    return;
                }

                if (e.key !== 'Escape') return;

                // 1) Отмена подсветки кабеля
                const bar = document.getElementById('highlight-bar');
                const visibleHighlight = bar && !bar.classList.contains('hidden');
                try {
                    if (visibleHighlight) {
                        MapManager.clearHighlight();
                    }
                } catch (_) {}

                // 2) Отмена режимов добавления: направление / кабели (грунт/воздух/канализация)
                try {
                    const mm = (typeof MapManager !== 'undefined') ? MapManager : null;
                    if (!mm) return;
                    const anyAdd =
                        !!mm.addDirectionMode ||
                        !!mm.addCableMode ||
                        !!mm.addDuctCableMode ||
                        !!mm.addingObject;
                    if (anyAdd) {
                        mm.cancelAddDirectionMode?.();
                        mm.cancelAddingObject?.();
                        mm.cancelAddCableMode?.();
                        mm.cancelAddDuctCableMode?.();
                    }
                    // Дополнительно: отмена режимов инструментов
                    if (mm.movePointMode) {
                        mm.cancelMovePointMode?.();
                        document.getElementById('btn-move-point-map')?.classList?.toggle('active', false);
                    }
                    if (mm.relocateDuctCableMode) {
                        mm.toggleRelocateDuctCableMode?.();
                        document.getElementById('btn-relocate-duct-cable-map')?.classList?.toggle('active', false);
                    }
                    if (mm.shortestDuctCableMode) {
                        mm.toggleShortestDuctCableMode?.();
                        document.getElementById('btn-add-duct-cable-shortest-map')?.classList?.toggle('active', false);
                    }
                    if (mm.inventoryMode) {
                        mm.cancelInventoryMode?.();
                        document.getElementById('btn-inventory-mode')?.classList?.toggle('active', false);
                    }
                    if (mm.stuffWellMode) {
                        mm.toggleStuffWellMode?.();
                        document.getElementById('btn-stuff-well-map')?.classList?.toggle('active', false);
                    }
                    if (mm.rulerMode) {
                        mm.cancelRulerMode?.({ notify: true });
                        document.getElementById('btn-ruler')?.classList?.toggle('active', false);
                    }

                    // 3) Снять выделение на карте (одиночное/множественное)
                    try {
                        const hasMulti = !!(mm.multiSelected && (mm.multiSelected.size || 0) > 0);
                        if (hasMulti) {
                            mm.clearMultiSelection?.();
                            this.notify('Выделение снято', 'info');
                            e.preventDefault();
                            return;
                        }
                        const panel = document.getElementById('object-info-panel');
                        const visible = panel && !panel.classList.contains('hidden');
                        if (visible) {
                            mm.hideObjectInfo?.();
                            this.notify('Выделение снято', 'info');
                            e.preventDefault();
                            return;
                        }
                        if (mm.selectedLayer) {
                            mm.clearSelectedObject?.();
                            this.notify('Выделение снято', 'info');
                            e.preventDefault();
                            return;
                        }
                    } catch (_) {}
                } catch (_) {}
            });
        }

        // Ctrl = "режим множественного выбора" в таблицах объектов (показываем чекбоксы)
        if (!this._boundCtrlDown) {
            this._boundCtrlDown = true;
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Control') document.body.classList.add('ctrl-down');
            });
            document.addEventListener('keyup', (e) => {
                if (e.key === 'Control') document.body.classList.remove('ctrl-down');
            });
            window.addEventListener('blur', () => document.body.classList.remove('ctrl-down'));
        }

        // Alt + hotkey из "Настройки" = запуск инструмента панели карты
        if (!this._boundAltHotkeys) {
            this._boundAltHotkeys = true;
            document.addEventListener('keydown', (e) => {
                try {
                    if (!e.altKey || e.ctrlKey || e.metaKey) return;
                    const key = (e.key || '').toString();
                    if (!key || key.length !== 1) return;

                    // Не перехватываем ввод в полях
                    const t = e.target;
                    const tag = (t?.tagName || '').toUpperCase();
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;

                    const k = key.toLowerCase();
                    const s = this.settings || {};
                    const map = {
                        [String(s.hotkey_add_direction || '').toLowerCase()]: 'btn-add-direction-map',
                        [String(s.hotkey_add_well || '').toLowerCase()]: 'btn-add-well-map',
                        [String(s.hotkey_add_marker || '').toLowerCase()]: 'btn-add-marker-map',
                        [String(s.hotkey_add_duct_cable || '').toLowerCase()]: 'btn-add-duct-cable-map',
                        [String(s.hotkey_add_ground_cable || '').toLowerCase()]: 'btn-add-ground-cable-map',
                        [String(s.hotkey_add_aerial_cable || '').toLowerCase()]: 'btn-add-aerial-cable-map',
                    };
                    const btnId = map[k];
                    if (!btnId || k === '') return;
                    const btn = document.getElementById(btnId);
                    if (!btn) return;

                    e.preventDefault();
                    btn.click();
                } catch (_) {
                    // ignore
                }
            });
        }

        // Панель инструментов карты
        document.getElementById('btn-add-direction-map')?.addEventListener('click', () => {
            if (MapManager.addDirectionMode) MapManager.cancelAddDirectionMode?.();
            else {
                MapManager.cancelAddingObject?.();
                MapManager.cancelAddCableMode?.({ notify: false });
                MapManager.cancelAddDuctCableMode?.({ notify: false });
                MapManager.startAddDirectionMode();
            }
        });
        document.getElementById('btn-add-well-map')?.addEventListener('click', () => {
            if (MapManager.addingObject === 'wells') {
                MapManager.cancelAddingObject?.();
                return;
            }
            MapManager.cancelAddDirectionMode?.();
            MapManager.cancelAddCableMode?.({ notify: false });
            MapManager.cancelAddDuctCableMode?.({ notify: false });
            MapManager.startAddingObject('wells');
        });
        document.getElementById('btn-stuff-well-map')?.addEventListener('click', (e) => {
            try {
                MapManager.toggleStuffWellMode?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.stuffWellMode);
            } catch (_) {}
        });
        document.getElementById('btn-add-marker-map')?.addEventListener('click', () => {
            if (MapManager.addingObject === 'markers') {
                MapManager.cancelAddingObject?.();
                return;
            }
            MapManager.cancelAddDirectionMode?.();
            MapManager.cancelAddCableMode?.({ notify: false });
            MapManager.cancelAddDuctCableMode?.({ notify: false });
            MapManager.startAddingObject('markers');
        });
        document.getElementById('btn-add-ground-cable-map')?.addEventListener('click', () => {
            if (MapManager.addCableMode && MapManager.addCableTypeCode === 'cable_ground') {
                MapManager.cancelAddCableMode?.();
                return;
            }
            MapManager.cancelAddDirectionMode?.();
            MapManager.cancelAddingObject?.();
            MapManager.cancelAddDuctCableMode?.({ notify: false });
            MapManager.cancelAddCableMode?.({ notify: false });
            MapManager.startAddCableMode('cable_ground');
        });
        document.getElementById('btn-add-aerial-cable-map')?.addEventListener('click', () => {
            if (MapManager.addCableMode && MapManager.addCableTypeCode === 'cable_aerial') {
                MapManager.cancelAddCableMode?.();
                return;
            }
            MapManager.cancelAddDirectionMode?.();
            MapManager.cancelAddingObject?.();
            MapManager.cancelAddDuctCableMode?.({ notify: false });
            MapManager.cancelAddCableMode?.({ notify: false });
            MapManager.startAddCableMode('cable_aerial');
        });
        document.getElementById('btn-add-duct-cable-map')?.addEventListener('click', () => {
            if (MapManager.addDuctCableMode) {
                MapManager.cancelAddDuctCableMode?.();
                return;
            }
            MapManager.cancelAddDirectionMode?.();
            MapManager.cancelAddingObject?.();
            MapManager.cancelAddCableMode?.({ notify: false });
            MapManager.startAddDuctCableMode();
        });
        document.getElementById('btn-add-duct-cable-shortest-map')?.addEventListener('click', (e) => {
            try {
                MapManager.toggleShortestDuctCableMode?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.shortestDuctCableMode);
            } catch (_) {}
        });
        document.getElementById('btn-inventory-mode')?.addEventListener('click', (e) => {
            try {
                MapManager.toggleInventoryMode?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.inventoryMode);
            } catch (_) {}
        });
        document.getElementById('btn-relocate-duct-cable-map')?.addEventListener('click', (e) => {
            try {
                MapManager.toggleRelocateDuctCableMode?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.relocateDuctCableMode);
            } catch (_) {}
        });
        document.getElementById('btn-move-point-map')?.addEventListener('click', (e) => {
            try {
                MapManager.toggleMovePointMode?.();
                e.currentTarget?.classList?.toggle('active', !!MapManager.movePointMode);
            } catch (_) {}
        });
        document.getElementById('btn-toggle-well-labels')?.addEventListener('click', (e) => {
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            MapManager.toggleWellLabels();
            e.currentTarget.classList.toggle('active', MapManager.wellLabelsEnabled);
        });
        document.getElementById('btn-toggle-object-coordinates')?.addEventListener('click', (e) => {
            try {
                try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
                MapManager.toggleObjectCoordinatesLabels?.();
                e.currentTarget.classList.toggle('active', !!MapManager.objectCoordinatesLabelsEnabled);
            } catch (_) {}
        });
        document.getElementById('btn-toggle-direction-length-labels')?.addEventListener('click', (e) => {
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            MapManager.toggleDirectionLengthLabels();
            e.currentTarget.classList.toggle('active', MapManager.directionLengthLabelsEnabled);
        });
        document.getElementById('btn-toggle-owner-legend')?.addEventListener('click', (e) => {
            MapManager.toggleOwnersLegend();
            e.currentTarget.classList.toggle('active', MapManager.ownersLegendEnabled);
        });
        document.getElementById('btn-map-defaults')?.addEventListener('click', (e) => {
            MapManager.toggleMapDefaults();
            e.currentTarget.classList.toggle('active', MapManager.mapDefaultsEnabled);
        });
        document.getElementById('btn-tu-mode')?.addEventListener('click', () => {
            this.openTuModeModal().catch(() => {});
        });
        document.getElementById('btn-refresh-map')?.addEventListener('click', async () => {
            try {
                await MapManager.refreshMapPreserveView?.();
                this.notify('Карта обновлена', 'success');
            } catch (e) {
                this.notify(e?.message || 'Не удалось обновить карту', 'error');
            }
        });
        document.getElementById('btn-cancel-add-mode')?.addEventListener('click', () => {
            MapManager.cancelAddDirectionMode();
            MapManager.cancelAddingObject();
            MapManager.cancelAddCableMode();
            MapManager.cancelAddDuctCableMode();
            MapManager.cancelInventoryMode?.();
            MapManager.cancelRulerMode?.({ notify: true });
            try { document.getElementById('btn-ruler')?.classList?.toggle('active', false); } catch (_) {}
        });
        document.getElementById('btn-finish-add-mode')?.addEventListener('click', () => MapManager.finishAddCableMode());
    },

    copyCurrentObjectCoordinates() {
        const panel = document.getElementById('object-info-panel');
        if (!panel) return;
        const objectType = panel.dataset.objectType;
        if (objectType !== 'well') return;

        const number = document.getElementById('info-title')?.textContent || 'Колодец';
        const lat = panel.dataset.lat;
        const lng = panel.dataset.lng;
        if (!lat || !lng) {
            this.notify('Координаты недоступны', 'warning');
            return;
        }

        const text = `${number}\nWGS84: ${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`;
        const doNotify = () => this.notify('Координаты скопированы', 'success');

        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(doNotify).catch(() => {
                // fallback
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                doNotify();
            });
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            doNotify();
        }
    },

    async refreshObjectTypeColors(redrawMap = true) {
        const resp = await API.references.all('object_types');
        if (!resp?.success) return;

        const byCode = {};
        (resp.data || []).forEach(t => {
            if (t?.code) byCode[t.code] = t;
        });

        // Коды системных типов (используются в логике слоёв/карты)
        const codeToColor = {
            well: byCode.well?.color,
            channel: byCode.channel?.color,
            marker: byCode.marker?.color,
            cable_ground: byCode.cable_ground?.color,
            cable_aerial: byCode.cable_aerial?.color,
            cable_duct: byCode.cable_duct?.color,
        };

        // Обновляем MapManager.colors
        if (codeToColor.well) MapManager.colors.wells = codeToColor.well;
        if (codeToColor.channel) MapManager.colors.channels = codeToColor.channel;
        if (codeToColor.marker) MapManager.colors.markers = codeToColor.marker;
        if (codeToColor.cable_ground) MapManager.colors.groundCables = codeToColor.cable_ground;
        if (codeToColor.cable_aerial) MapManager.colors.aerialCables = codeToColor.cable_aerial;
        if (codeToColor.cable_duct) MapManager.colors.ductCables = codeToColor.cable_duct;

        // Обновляем цвета иконок слоёв в меню
        const setLayerIcon = (checkboxId, color) => {
            const input = document.getElementById(checkboxId);
            const icon = input?.closest('label')?.querySelector('.layer-icon');
            if (icon && color) icon.style.background = color;
        };
        const setLayerName = (checkboxId, name) => {
            const input = document.getElementById(checkboxId);
            const label = input?.closest('label');
            if (!label || !name) return;
            const titleSpan = label.querySelector('span.layer-title');
            if (titleSpan) {
                titleSpan.textContent = name;
                return;
            }
            // fallback: first span that is not icon/controls
            const spans = Array.from(label.querySelectorAll('span') || []);
            const s = spans.find(x =>
                !x.classList.contains('layer-icon') &&
                !x.classList.contains('layer-inline-controls') &&
                !x.classList.contains('layer-title')
            );
            if (s) s.textContent = name;
        };
        setLayerIcon('layer-wells', codeToColor.well);
        setLayerIcon('layer-channels', codeToColor.channel);
        setLayerIcon('layer-markers', codeToColor.marker);
        setLayerIcon('layer-ground-cables', codeToColor.cable_ground);
        setLayerIcon('layer-aerial-cables', codeToColor.cable_aerial);
        setLayerIcon('layer-duct-cables', codeToColor.cable_duct);

        // Обновляем названия слоёв из справочника "Виды объектов"
        // Для "Колодцы"/"Направления каналов" оставляем фиксированные подписи UI (чтобы не ломать UX).
        setLayerName('layer-markers', byCode.marker?.name);
        setLayerName('layer-ground-cables', byCode.cable_ground?.name);
        setLayerName('layer-aerial-cables', byCode.cable_aerial?.name);
        setLayerName('layer-duct-cables', byCode.cable_duct?.name);

        if (redrawMap && MapManager?.map) {
            MapManager.loadAllLayers();
        }
    },

    /**
     * Обработка авторизации
     */
    async handleLogin(e) {
        e.preventDefault();
        
        const login = document.getElementById('login').value;
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('login-error');

        try {
            const response = await API.auth.login(login, password);
            
            if (response.success) {
                this.user = response.data.user;
                this.showApp();
            } else {
                errorEl.textContent = response.message || 'Ошибка авторизации';
                errorEl.classList.remove('hidden');
            }
        } catch (error) {
            errorEl.textContent = error.message || 'Ошибка подключения к серверу';
            errorEl.classList.remove('hidden');
        }
    },

    /**
     * Обработка выхода
     */
    async handleLogout() {
        try {
            await API.auth.logout();
        } catch (error) {
            console.error('Logout error:', error);
        }
        
        API.clearToken();
        this.user = null;
        this.showLogin();
    },

    /**
     * Переключение панели
     */
    switchPanel(panel) {
        // Роль "Только чтение": доступна только карта
        if ((this.user?.role?.code || '') === 'readonly' && panel !== 'map') {
            panel = 'map';
        }
        this.currentPanel = panel;

        // Обновляем навигацию
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.panel === panel);
        });

        // Обновляем контент
        document.querySelectorAll('.content-panel').forEach(el => {
            el.classList.toggle('active', el.id === `content-${panel}`);
        });

        // Загружаем данные для панели
        switch (panel) {
            case 'objects':
                // Важно: при первом входе в "Объекты" нужно корректно показать фильтры выбранной вкладки
                // (иначе для "Колодцы" фильтр может не появиться до переключения вкладок).
                this.switchTab(this.currentTab || 'wells');
                break;
            case 'incidents':
                this.loadIncidents();
                break;
            case 'contracts':
                this.loadContractsPanel();
                break;
            case 'references':
                // При уходе в "Контракты" currentReference становится 'contracts',
                // но в панели "Справочники" может быть открыт другой справочник (например "owners").
                // Восстанавливаем актуальный currentReference, чтобы editReference() не ходил в /contracts/{id}.
                {
                    const refContent = document.getElementById('reference-content');
                    const isContentVisible = refContent && !refContent.classList.contains('hidden');
                    if (isContentVisible) {
                        this.currentReference = this.lastReferenceInReferencesPanel || this.currentReference;
                        const addBtn = document.getElementById('btn-add-ref');
                        if (addBtn) {
                            addBtn.classList.toggle('hidden', !this.canManageReferenceType(this.currentReference) || this.currentReference === 'object_types');
                        }
                    } else {
                        this.currentReference = null;
                    }
                }
                break;
            case 'admin':
                this.loadUsers();
                break;
            case 'settings':
                this.loadSettingsPanel();
                break;
        }
    },

    /**
     * Установка темы
     */
    setTheme(theme) {
        document.body.className = `theme-${theme}`;
        document.getElementById('btn-theme-dark').classList.toggle('active', theme === 'dark');
        document.getElementById('btn-theme-grey').classList.toggle('active', theme === 'grey');
        localStorage.setItem('igs_theme', theme);
    },

    isAdmin() {
        return this.user?.role?.code === 'admin';
    },

    isRoot() {
        return this.user?.login === 'root';
    },

    hasPermission(key) {
        const p = this.user?.permissions || {};
        return p?.all === true || p?.[key] === true;
    },

    canWrite() {
        return this.hasPermission('write');
    },

    canDelete() {
        const rc = this.user?.role?.code || '';
        if (rc === 'admin' || rc === 'user') return true;
        return this.hasPermission('delete');
    },

    canManageReferences() {
        return this.isAdmin();
    },

    canManageReferenceType(type) {
        // Контракты: разрешаем создавать/редактировать роли "Пользователь" (при наличии write).
        if (type === 'contracts') return this.canWrite() || this.isAdmin();
        return this.canManageReferences();
    },

    /**
     * Установка системы координат
     */
    setCoordinateSystem(system) {
        MapManager.setCoordinateSystem(system);
        document.getElementById('btn-wgs84').classList.toggle('active', system === 'wgs84');
    },

    /**
     * Переключение слоя
     */
    handleLayerToggle(input) {
        // Роль "Только чтение": слой "Инвентаризация" недоступен
        if ((this.user?.role?.code || '') === 'readonly' && input?.id === 'layer-inventory') {
            try { input.checked = false; } catch (_) {}
            try { this.notify('Слой "Инвентаризация" недоступен для роли "Только чтение"', 'warning'); } catch (_) {}
            return;
        }
        const layerMap = {
            'layer-wells': 'wells',
            'layer-channels': 'channels',
            'layer-inventory': 'inventory',
            'layer-markers': 'markers',
            'layer-ground-cables': 'groundCables',
            'layer-aerial-cables': 'aerialCables',
            'layer-duct-cables': 'ductCables',
        };
        
        const layerName = layerMap[input.id];
        if (!layerName) return;

        // Колодцы: кнопки подсказок (номера/координаты) всегда видимы, но disabled если слой off
        if (input.id === 'layer-wells') {
            try {
                const b1 = document.getElementById('btn-toggle-well-labels');
                const b2 = document.getElementById('btn-toggle-object-coordinates');
                if (b1) {
                    b1.disabled = !input.checked;
                    b1.classList.toggle('active', input.checked && !!MapManager.wellLabelsEnabled);
                }
                if (b2) {
                    b2.disabled = !input.checked;
                    b2.classList.toggle('active', input.checked && !!MapManager.objectCoordinatesLabelsEnabled);
                }
            } catch (_) {}
        }

        // Направления: кнопка "Подсказки длина направления" всегда видима, но disabled если слой off
        if (input.id === 'layer-channels') {
            try {
                const btn = document.getElementById('btn-toggle-direction-length-labels');
                if (btn) {
                    btn.disabled = !input.checked;
                    btn.classList.toggle('active', input.checked && !!MapManager.directionLengthLabelsEnabled);
                }
            } catch (_) {}
        }

        // Инвентаризация: при включении автоматически выключаем все слои,
        // оставляем "Колодцы" и "Инвентаризация" (или режим "Предполагаемые кабели" внутри инвентаризации).
        if (input.id === 'layer-inventory' && input.checked) {
            const set = (id, name, checked) => {
                const cb = document.getElementById(id);
                if (cb) cb.checked = checked;
                MapManager.toggleLayer(name, checked);
            };
            set('layer-wells', 'wells', true);
            set('layer-channels', 'channels', false);
            set('layer-markers', 'markers', false);
            set('layer-ground-cables', 'groundCables', false);
            set('layer-aerial-cables', 'aerialCables', false);
            set('layer-duct-cables', 'ductCables', false);

            // режим внутри инвентаризации: показываем либо inventory, либо assumedCables
            this.applyInventoryAssumedModeLayers_();
            this.syncInventoryAssumedControls_();

            // синхронизируем кнопку длины направлений
            try {
                const btn = document.getElementById('btn-toggle-direction-length-labels');
                if (btn) {
                    btn.disabled = true;
                    btn.classList.toggle('active', false);
                }
            } catch (_) {}
            this.saveLayerPreferencesDebounced();
            return;
        }

        // если выключили слой инвентаризации — прячем кнопку подсказок
        if (input.id === 'layer-inventory' && !input.checked) {
            try {
                const btn = document.getElementById('btn-inventory-unacc-labels');
                if (btn) {
                    btn.disabled = true;
                    btn.classList.toggle('active', false);
                }
            } catch (_) {}
            // также выключаем режим предполагаемых кабелей и прячем панель
            try {
                this.assumedCablesModeEnabled = false;
                this.applyInventoryAssumedModeLayers_();
                this.syncInventoryAssumedControls_();
            } catch (_) {}
        }

        // Кабели: кнопка "Список" активна только если слой включен
        if (input.id === 'layer-ground-cables') {
            try {
                const btn = document.getElementById('btn-list-ground-cables');
                if (btn) {
                    btn.disabled = !input.checked;
                    if (!input.checked) btn.classList.toggle('active', false);
                }
                if (!input.checked) MapManager?.setCablesListPanelVisible?.(false, { onlyIfType: 'ground' });
            } catch (_) {}
        }
        if (input.id === 'layer-aerial-cables') {
            try {
                const btn = document.getElementById('btn-list-aerial-cables');
                if (btn) {
                    btn.disabled = !input.checked;
                    if (!input.checked) btn.classList.toggle('active', false);
                }
                if (!input.checked) MapManager?.setCablesListPanelVisible?.(false, { onlyIfType: 'aerial' });
            } catch (_) {}
        }
        if (input.id === 'layer-duct-cables') {
            try {
                const btn = document.getElementById('btn-list-duct-cables');
                if (btn) {
                    btn.disabled = !input.checked;
                    if (!input.checked) btn.classList.toggle('active', false);
                }
                if (!input.checked) MapManager?.setCablesListPanelVisible?.(false, { onlyIfType: 'duct' });
            } catch (_) {}
        }

        MapManager.toggleLayer(layerName, input.checked);
        this.saveLayerPreferencesDebounced();
    },

    showLayerOrderModal() {
        const mm = (typeof MapManager !== 'undefined') ? MapManager : null;
        const items = mm?.layerOrderItems || [];
        const byKey = new Map(items.map(x => [x.key, x]));
        const order = (typeof mm?.getCurrentLayerOrderKeys === 'function')
            ? mm.getCurrentLayerOrderKeys()
            : items.map(x => x.key);

        const renderListHtml = (keys) => {
            const ks = Array.isArray(keys) ? keys : [];
            return ks.map((k) => {
                const it = byKey.get(k);
                if (!it) return '';
                const fixed = !!it.fixedBottom;
                const title = this.escapeHtml(it.title || it.key);
                const keyEsc = this.escapeHtml(it.key);
                return `
                    <div class="layer-order-item ${fixed ? 'fixed' : ''}" data-key="${keyEsc}" draggable="${fixed ? 'false' : 'true'}">
                        <span class="layer-order-handle"><i class="fas fa-grip-vertical"></i></span>
                        <span class="layer-order-title">${title}</span>
                        ${fixed ? `<span class="text-muted" style="margin-left:auto; font-size:12px;">фикс.</span>` : ''}
                    </div>
                `;
            }).join('');
        };

        const content = `
            <div class="layer-order-list" id="layer-order-list">
                ${renderListHtml(order)}
            </div>
            <div class="text-muted" style="margin-top:10px;">Перетащите элементы. Позиция 1 — самый верхний слой (поверх всех).</div>
        `;
        const footer = `
            <button class="btn btn-secondary" id="btn-layer-order-reset">По умолчанию</button>
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" id="btn-layer-order-save"><i class="fas fa-save"></i> Сохранить</button>
        `;
        this.showModal('Порядок отображения слоёв', content, footer);

        setTimeout(() => {
            const list = document.getElementById('layer-order-list');
            if (!list) return;

            let dragging = null;
            const getAfter = (container, y) => {
                const els = [...container.querySelectorAll('.layer-order-item:not(.dragging):not(.fixed)')];
                let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
                for (const el of els) {
                    const box = el.getBoundingClientRect();
                    const offset = y - (box.top + box.height / 2);
                    if (offset < 0 && offset > closest.offset) closest = { offset, element: el };
                }
                return closest.element;
            };

            const bindDragHandlers = () => {
                dragging = null;
                list.querySelectorAll('.layer-order-item').forEach((el) => {
                    if (el.classList.contains('fixed')) return;
                    el.addEventListener('dragstart', (e) => {
                        dragging = el;
                        el.classList.add('dragging');
                        try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
                    });
                    el.addEventListener('dragend', () => {
                        el.classList.remove('dragging');
                        dragging = null;
                    });
                });
            };
            bindDragHandlers();

            list.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!dragging) return;
                const after = getAfter(list, e.clientY);
                if (!after) list.appendChild(dragging);
                else list.insertBefore(dragging, after);
            });

            document.getElementById('btn-layer-order-reset')?.addEventListener('click', (e) => {
                try { e.preventDefault(); } catch (_) {}
                const defKeys = (typeof mm?.getLayerOrderDefaultKeys === 'function')
                    ? mm.getLayerOrderDefaultKeys()
                    : items.map(x => x.key);
                list.innerHTML = renderListHtml(defKeys);
                bindDragHandlers();
            });

            document.getElementById('btn-layer-order-save')?.addEventListener('click', (e) => {
                try { e.preventDefault(); } catch (_) {}
                const keys = [...list.querySelectorAll('.layer-order-item')].map(x => x.getAttribute('data-key'));
                try {
                    mm?.setLayerOrderKeys?.(keys, { save: true });
                    this.hideModal();
                    this.notify('Порядок слоёв сохранён', 'success');
                } catch (err) {
                    this.notify(err?.message || 'Не удалось сохранить порядок слоёв', 'error');
                }
            });
        }, 0);
    },

    setAssumedCablesModeEnabled(enabled, opts = {}) {
        if ((this.user?.role?.code || '') === 'readonly') {
            // режим предполагаемых кабелей является частью функционала инвентаризации
            this.assumedCablesModeEnabled = false;
            try { this.syncInventoryAssumedControls_(); } catch (_) {}
            try { this.notify('Функционал "Инвентаризация" недоступен для роли "Только чтение"', 'warning'); } catch (_) {}
            return;
        }
        const ensureInventoryOn = (opts?.ensureInventoryOn !== false);
        this.assumedCablesModeEnabled = !!enabled;

        // если включаем режим — убедимся, что включена "Инвентаризация" (это master-переключатель)
        if (this.assumedCablesModeEnabled && ensureInventoryOn) {
            try {
                const invCb = document.getElementById('layer-inventory');
                if (invCb && !invCb.checked) {
                    invCb.checked = true;
                    this.handleLayerToggle(invCb);
                }
            } catch (_) {}
        }

        // переключаем отображение слоёв в соответствии с режимом
        this.applyInventoryAssumedModeLayers_();
        // синхронизируем доступность кнопок/панели
        this.syncInventoryAssumedControls_();
    },

    applyInventoryAssumedModeLayers_() {
        const invOn = !!document.getElementById('layer-inventory')?.checked;
        const assumedOn = invOn && !!this.assumedCablesModeEnabled;
        try {
            MapManager.toggleLayer('inventory', invOn && !assumedOn);
        } catch (_) {}
        try {
            MapManager.toggleLayer('assumedCables', invOn && assumedOn);
        } catch (_) {}
        try {
            MapManager.setAssumedCablesPanelVisible?.(invOn && assumedOn);
            if (invOn && assumedOn) MapManager.refreshAssumedCablesPanel?.();
        } catch (_) {}
    },

    syncInventoryAssumedControls_() {
        const invOn = !!document.getElementById('layer-inventory')?.checked;
        const assumedOn = invOn && !!this.assumedCablesModeEnabled;

        try {
            const btnMode = document.getElementById('btn-toggle-assumed-cables');
            if (btnMode) {
                btnMode.disabled = !invOn;
                btnMode.classList.toggle('active', assumedOn);
            }
        } catch (_) {}

        // селект + пересчёт: активны только в режиме предполагаемых кабелей
        try {
            const sel = document.getElementById('assumed-cables-variant');
            const btn = document.getElementById('btn-assumed-cables-rebuild');
            if (sel) sel.disabled = !assumedOn;
            if (btn) btn.disabled = !assumedOn || !this.canWrite();
        } catch (_) {}

        // кнопка подсказок инвентаризации: активна только в режиме инвентаризации
        try {
            const btn = document.getElementById('btn-inventory-unacc-labels');
            if (btn) {
                if (assumedOn) {
                    btn.disabled = true;
                    btn.classList.toggle('active', false);
                    try { MapManager.setInventoryUnaccountedLabelsEnabled?.(false); } catch (_) {}
                } else {
                    // по требованию: при возврате из режима предполагаемых кабелей подсказки должны быть включены
                    try { MapManager.setInventoryUnaccountedLabelsEnabled?.(true); } catch (_) {}
                    btn.disabled = !invOn;
                    btn.classList.toggle('active', invOn && !!MapManager.inventoryUnaccountedLabelsEnabled);
                }
            }
        } catch (_) {}

        // если выключили режим предполагаемых кабелей — чистим подсветку/выделение и прячем панель
        if (!assumedOn) {
            try { MapManager.clearSelectedObject?.(); } catch (_) {}
            try { MapManager.clearHighlight?.(); } catch (_) {}
            try { MapManager.setAssumedCablesPanelVisible?.(false); } catch (_) {}
        }
    },

    /**
     * Загрузка опций фильтров
     */
    async loadFilterOptions() {
        try {
            // Группы
            const groups = await API.groups.list({ limit: 500 });
            if (groups.success !== false) {
                const select = document.getElementById('filter-group');
                if (!select) return;
                // сбросим, чтобы не дублировать при повторной загрузке
                select.innerHTML = '<option value="">Все объекты</option>';
                const groupsData = groups.data || groups;
                groupsData.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.name}</option>`;
                });
            }

            // Собственники
            const owners = await API.references.all('owners');
            if (owners.success) {
                const select = document.getElementById('filter-owner');
                if (!select) return;
                select.innerHTML = '<option value="">Все</option>';
                owners.data.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.name}</option>`;
                });
            }

            // Состояния
            const statuses = await API.references.all('object_status');
            if (statuses.success) {
                const select = document.getElementById('filter-status');
                if (!select) return;
                select.innerHTML = '<option value="">Все</option>';
                statuses.data.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.name}</option>`;
                });
            }

            // Контракты
            const contracts = await API.references.all('contracts');
            if (contracts.success) {
                const select = document.getElementById('filter-contract');
                if (!select) return;
                select.innerHTML = '<option value="">Все</option>';
                const isReadonly = (this.user?.role?.code || '') === 'readonly';
                const userOwnerId = parseInt(this.user?.owner_id || 0, 10) || 0;
                const list = isReadonly && userOwnerId
                    ? (contracts.data || []).filter(c => String(c.owner_id || '') === String(userOwnerId))
                    : (contracts.data || []);
                list.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.number} - ${item.name}</option>`;
                });
            }
        } catch (error) {
            console.error('Ошибка загрузки фильтров:', error);
        }
    },

    /**
     * Применение фильтров
     */
    applyFilters() {
        let groupId = document.getElementById('filter-group').value;
        const ownerId = document.getElementById('filter-owner').value;
        let statusId = document.getElementById('filter-status').value;
        const contractId = document.getElementById('filter-contract').value;

        // Роль "Только чтение": фильтры ТУ и Состояние недоступны
        if ((this.user?.role?.code || '') === 'readonly') {
            groupId = '';
            statusId = '';
        }
        
        // Собираем все фильтры
        const filters = {};
        if (ownerId) filters.owner_id = ownerId;
        if (statusId) filters.status_id = statusId;
        if (contractId) filters.contract_id = contractId;

        // При выборе контракта:
        // - показываем все колодцы
        // - показываем только кабели выбранного контракта
        // - НЕ показываем направления и столбики
        if (contractId) {
            const setLayer = (checkboxId, layerName) => {
                const cb = document.getElementById(checkboxId);
                if (cb) cb.checked = true;
                MapManager.toggleLayer(layerName, true);
            };
            const unsetLayer = (checkboxId, layerName) => {
                const cb = document.getElementById(checkboxId);
                if (cb) cb.checked = false;
                MapManager.toggleLayer(layerName, false);
            };
            setLayer('layer-wells', 'wells');
            setLayer('layer-ground-cables', 'groundCables');
            setLayer('layer-aerial-cables', 'aerialCables');
            setLayer('layer-duct-cables', 'ductCables');
            unsetLayer('layer-inventory', 'inventory');
            unsetLayer('layer-channels', 'channels');
            unsetLayer('layer-markers', 'markers');
            // выключаем режим предполагаемых кабелей и прячем панель
            try { this.setAssumedCablesModeEnabled(false, { ensureInventoryOn: false }); } catch (_) {}
            try { MapManager.toggleLayer('assumedCables', false); } catch (_) {}
            // синхронизируем кнопку длины направлений
            try {
                const btn = document.getElementById('btn-toggle-direction-length-labels');
                if (btn) {
                    btn.disabled = true;
                    btn.classList.toggle('active', false);
                }
            } catch (_) {}

            // синхронизируем inline-кнопки для включенных слоёв (кабели + колодцы)
            try {
                const inv = (id) => document.getElementById(id);
                // колодцы: подсказки/координаты доступны если слой колодцев включен
                const wellsOn = !!inv('layer-wells')?.checked;
                const b1 = inv('btn-toggle-well-labels');
                const b2 = inv('btn-toggle-object-coordinates');
                if (b1) {
                    b1.disabled = !wellsOn;
                    b1.classList.toggle('active', wellsOn && !!MapManager.wellLabelsEnabled);
                }
                if (b2) {
                    b2.disabled = !wellsOn;
                    b2.classList.toggle('active', wellsOn && !!MapManager.objectCoordinatesLabelsEnabled);
                }
                // кабели: кнопки "Список" доступны если соответствующий слой включен
                const syncList = (cbId, btnId) => {
                    const on = !!inv(cbId)?.checked;
                    const btn = inv(btnId);
                    if (!btn) return;
                    btn.disabled = !on;
                    if (!on) btn.classList.remove('active');
                };
                syncList('layer-ground-cables', 'btn-list-ground-cables');
                syncList('layer-aerial-cables', 'btn-list-aerial-cables');
                syncList('layer-duct-cables', 'btn-list-duct-cables');
            } catch (_) {}
        }
        
        // Если выбрана группа - загружаем объекты группы с учётом фильтров
        if (groupId) {
            MapManager.loadGroup(groupId, filters);
            this.notify('Загружена группа объектов с фильтрами', 'success');
            return;
        }
        
        // Применяем фильтры ко всем объектам
        MapManager.setFilters(filters);
        this.notify('Фильтры применены', 'success');
    },

    /**
     * Сброс фильтров
     */
    resetFilters() {
        document.getElementById('filter-group').value = '';
        document.getElementById('filter-owner').value = '';
        document.getElementById('filter-status').value = '';
        document.getElementById('filter-contract').value = '';

        // Слои по умолчанию:
        // активные: Колодцы, Направления каналов, Столбики
        // неактивные: Кабели в грунте, Воздушные кабели, Кабели в канализации
        const setLayer = (checkboxId, layerName, checked) => {
            const cb = document.getElementById(checkboxId);
            if (cb) cb.checked = checked;
            MapManager.toggleLayer(layerName, checked);
        };
        setLayer('layer-wells', 'wells', true);
        setLayer('layer-channels', 'channels', true);
        setLayer('layer-inventory', 'inventory', false);
        setLayer('layer-markers', 'markers', true);
        setLayer('layer-ground-cables', 'groundCables', false);
        setLayer('layer-aerial-cables', 'aerialCables', false);
        setLayer('layer-duct-cables', 'ductCables', false);

        // Синхронизация кнопок "Список" для кабельных слоёв
        try {
            const syncBtn = (cbId, btnId) => {
                const cb = document.getElementById(cbId);
                const btn = document.getElementById(btnId);
                if (!btn) return;
                const on = !!cb?.checked;
                btn.disabled = !on;
                if (!on) btn.classList.remove('active');
            };
            syncBtn('layer-ground-cables', 'btn-list-ground-cables');
            syncBtn('layer-aerial-cables', 'btn-list-aerial-cables');
            syncBtn('layer-duct-cables', 'btn-list-duct-cables');
        } catch (_) {}

        // выключаем режим предполагаемых кабелей и прячем панель
        try { this.setAssumedCablesModeEnabled(false, { ensureInventoryOn: false }); } catch (_) {}
        try { MapManager.toggleLayer('assumedCables', false); } catch (_) {}
        // синхронизируем UI контролов "колодцы"
        try {
            const b1 = document.getElementById('btn-toggle-well-labels');
            const b2 = document.getElementById('btn-toggle-object-coordinates');
            if (b1) b1.disabled = false;
            if (b2) b2.disabled = false;
        } catch (_) {}
        // синхронизируем кнопку длины направлений
        try {
            const btn = document.getElementById('btn-toggle-direction-length-labels');
            if (btn) {
                btn.disabled = false;
                btn.classList.toggle('active', !!MapManager.directionLengthLabelsEnabled);
            }
        } catch (_) {}

        MapManager.clearFilters();
        this.notify('Фильтры сброшены', 'info');
    },

    /**
     * Переключение таба объектов
     */
    switchTab(tab) {
        this.currentTab = tab;
        this.pagination.page = 1;
        this.selectedObjectIds.clear();
        this.updateBulkDeleteButton();

        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });

        // Показываем фильтры только для кабелей
        const cableFiltersRow = document.getElementById('cables-filters-row');
        if (cableFiltersRow) {
            cableFiltersRow.classList.toggle('hidden', tab !== 'unified_cables');
            if (tab === 'unified_cables') {
                this.loadCableListFilters();
            }
        }

        // Фильтры для остальных вкладок
        const objFiltersRow = document.getElementById('objects-filters-row');
        if (objFiltersRow) {
            const show = tab !== 'unified_cables' && tab !== 'groups';
            objFiltersRow.classList.toggle('hidden', !show);
            if (show) {
                this.loadObjectsListFilters(tab).catch(() => {});
            }
        }

        // Кнопка "Загрузить" доступна только для вкладки "Колодцы"
        const importBtn = document.getElementById('btn-import');
        if (importBtn) {
            importBtn.classList.toggle('hidden', tab !== 'wells' || !this.canWrite());
        }
        // Кнопка "Пересчитать длины" — только для вкладки "Кабели"
        document.getElementById('btn-recalc-cable-lengths')?.classList.toggle('hidden', tab !== 'unified_cables' || !this.canWrite());
        // Кнопка "Актуализировать собственника в номере" — только для "Колодцы"
        document.getElementById('btn-recalc-well-owner-code-in-number')?.classList.toggle('hidden', tab !== 'wells' || !this.canWrite());
        // Кнопка "Пересчитать неучтенные" — только для "Колодцы"
        document.getElementById('btn-recalc-inventory-unaccounted')?.classList.toggle('hidden', tab !== 'wells' || !this.canWrite());
        // Кнопка "Найти клоны" — только для "Колодцы"
        document.getElementById('btn-find-clones')?.classList.toggle('hidden', tab !== 'wells');
        // Кнопка "Обновить имена" — только для "Направления"
        document.getElementById('btn-recalc-direction-names')?.classList.toggle('hidden', tab !== 'directions' || !this.canWrite());
        // Чекбоксы "Колодцы ..." — только для "Колодцы"
        try {
            const wrap = document.getElementById('wells-extra-filters');
            if (wrap) wrap.style.display = (tab === 'wells') ? 'flex' : 'none';
        } catch (_) {}

        this.loadObjects();
    },

    async findWellClones() {
        if (this.currentTab !== 'wells') {
            this.switchTab('wells');
        }
        try {
            const resp = await API.wells.clones();
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка поиска клонов', 'error');
                return;
            }
            const rows = resp?.data || resp || [];
            if (!Array.isArray(rows) || rows.length === 0) {
                this.notify('Клоны не найдены', 'info');
                return;
            }

            const keyOf = (r) => `${String(r.latitude ?? '')}|${String(r.longitude ?? '')}`;
            const groups = new Map();
            for (const r of rows) {
                const k = keyOf(r);
                if (!groups.has(k)) {
                    groups.set(k, {
                        latitude: r.latitude,
                        longitude: r.longitude,
                        clone_count: Number(r.clone_count || 0) || 0,
                        items: [],
                    });
                }
                groups.get(k).items.push(r);
            }

            // Сортируем группы: по count desc
            const sortedGroups = Array.from(groups.values()).sort((a, b) => (b.clone_count || 0) - (a.clone_count || 0));

            const fmt = (v) => {
                if (v === null || v === undefined || v === '') return '-';
                const n = Number(v);
                if (!Number.isFinite(n)) return this.escapeHtml(String(v));
                return n.toFixed(7);
            };

            const content = `
                <div style="display:flex; flex-direction:column; gap:14px;">
                    ${sortedGroups.map(g => `
                        <div style="border:1px solid var(--border-color); border-radius:8px; overflow:hidden;">
                            <div style="padding:10px 12px; background: var(--bg-secondary); display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
                                <span><strong>${g.clone_count || g.items.length}</strong> шт</span>
                                <span>Широта (WGS84): <strong>${fmt(g.latitude)}</strong></span>
                                <span>Долгота (WGS84): <strong>${fmt(g.longitude)}</strong></span>
                            </div>
                            <div style="max-height: 260px; overflow:auto;">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Номер</th>
                                            <th>Вид</th>
                                            <th>Тип</th>
                                            <th>Статус</th>
                                            <th>Собственник</th>
                                            <th>Действия</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${(g.items || []).map(r => `
                                            <tr>
                                                <td>${this.escapeHtml(String(r.number || ''))}</td>
                                                <td>${this.escapeHtml(String(r.type_name || ''))}</td>
                                                <td>${this.escapeHtml(String(r.kind_name || ''))}</td>
                                                <td>${this.escapeHtml(String(r.status_name || ''))}</td>
                                                <td>${this.escapeHtml(String(r.owner_short || r.owner_name || ''))}</td>
                                                <td style="white-space:nowrap;">
                                                    <button class="btn btn-sm btn-secondary" onclick="App.viewObject(${Number(r.id)})" title="Показать на карте">
                                                        <i class="fas fa-eye"></i>
                                                    </button>
                                                    ${this.canWrite() ? `
                                                        <button class="btn btn-sm btn-primary" onclick="App.editObject(${Number(r.id)})" title="Редактировать">
                                                            <i class="fas fa-edit"></i>
                                                        </button>
                                                    ` : ``}
                                                </td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;

            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            this.showModal('Найти клоны: колодцы (WGS84)', content, footer);
        } catch (e) {
            this.notify(e?.message || 'Ошибка поиска клонов', 'error');
        }
    },

    // ========================
    // Инвентаризация: карточки колодцев
    // ========================

    async showAddInventoryCardModal(wellId, prefill = null) {
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        const wid = parseInt(wellId || 0, 10);
        if (!wid) return;

        try {
            // directions for well
            const [dirsResp, cardsResp, ownersResp] = await Promise.all([
                API.inventory.wellDirections(wid),
                API.inventory.byWell(wid).catch(() => ({ success: true, data: [] })),
                API.references.all('owners').catch(() => ({ success: true, data: [] })),
            ]);
            const dirs = dirsResp?.data || dirsResp || [];
            const cards = cardsResp?.data || cardsResp || [];
            const owners = ownersResp?.data || ownersResp || [];

            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            const defDate = `${yyyy}-${mm}-${dd}`;

            const countsMap = {};
            const pre = prefill && typeof prefill === 'object' ? prefill : null;
            const preDir = pre?.directionCounts || null;
            if (preDir && typeof preDir === 'object') {
                Object.keys(preDir).forEach(k => {
                    const n = parseInt(k, 10);
                    if (!n) return;
                    const v = parseInt(preDir[k], 10);
                    countsMap[n] = Number.isFinite(v) ? v : 0;
                });
            }

            const tags = Array.isArray(pre?.tags) ? pre.tags : [];

            const ownersOptions = `<option value="">Выберите собственника...</option>` +
                (owners || []).map(o => `<option value="${o.id}">${this.escapeHtml(o.name || o.code || o.id)}</option>`).join('');

            const directionsRows = (dirs || []).map(d => {
                const did = Number(d.id || 0);
                const v = Math.max(0, Math.min(100, Number(countsMap[did] ?? 0) || 0));
                const label = `${d.number || did} (${d.start_well_number || d.start_well_id || '-'} → ${d.end_well_number || d.end_well_id || '-'})`;
                return `
                    <div class="form-group" style="margin-bottom:10px;">
                        <label>${this.escapeHtml(label)}</label>
                        <input type="number" class="inv-dir-count" data-direction-id="${did}" min="0" max="100" value="${v}">
                    </div>
                `;
            }).join('');

            const tagsRows = (tags.length ? tags : [null]).map((t, idx) => {
                const val = t ? String(t) : '';
                return `
                    <div class="form-group inv-tag-row" style="display:flex; gap:8px; align-items:center;">
                        <select class="inv-tag-owner" style="flex:1;">${ownersOptions}</select>
                        <button type="button" class="btn btn-sm btn-danger" onclick="App.removeInvTagRow(this)" title="Удалить бирку"><i class="fas fa-trash"></i></button>
                    </div>
                `;
            }).join('');

            const content = `
                <div style="display:flex; gap:16px; align-items:flex-start;">
                    <div style="flex: 1 1 auto; min-width: 380px;">
                        <div class="form-group">
                            <label>Номер</label>
                            <input type="text" value="(авто: ИНВ-<код собственника>-<номер>)" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Дата заполнения</label>
                            <input type="date" id="inv-filled-date" value="${defDate}">
                        </div>

                        <hr>
                        <h4>Кабели в направлениях колодца</h4>
                        <div style="max-height: 45vh; overflow:auto; padding-right:6px;">
                            ${directionsRows || '<div class="text-muted">У колодца нет направлений</div>'}
                        </div>

                        <hr>
                        <h4>Обнаруженные бирки</h4>
                        <div id="inv-tags">${tagsRows}</div>
                        <button type="button" class="btn btn-sm btn-secondary" onclick="App.addInvTagRow()">
                            <i class="fas fa-plus"></i> Добавить бирку
                        </button>

                        <hr>
                        <h4>Файлы</h4>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input type="file" id="inv-create-attachment-file" multiple>
                        </div>
                        <div class="text-muted" style="margin-top:6px;">Файлы будут загружены после создания карточки.</div>
                    </div>

                    <div style="flex: 0 0 280px; max-width: 280px;">
                        <div class="text-muted" style="margin-bottom:8px;">Карточки колодца</div>
                        <div style="max-height: 65vh; overflow:auto; border:1px solid var(--border-color); border-radius:6px; padding:8px;">
                            ${(cards || []).map(c => `
                                <button class="btn btn-block btn-secondary" style="margin-bottom:8px;" onclick="App.openInventoryCard(${Number(c.id)})">
                                    ${this.escapeHtml(c.number || c.id)}<br>
                                    <span class="text-muted">${this.escapeHtml(c.filled_date || '')}</span>
                                </button>
                            `).join('') || `<div class="text-muted">Пока нет карточек</div>`}
                        </div>
                    </div>
                </div>
            `;
            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
                <button class="btn btn-primary" onclick="App.submitInventoryCardCreate(${wid})"><i class="fas fa-save"></i> Создать</button>
            `;
            this.showModal('Инвентарная карточка — создание', content, footer, { fitContent: true });

            // preselect tag values
            try {
                const selects = Array.from(document.querySelectorAll('#inv-tags .inv-tag-owner'));
                selects.forEach((s, idx) => {
                    const v = tags[idx] ? String(tags[idx]) : '';
                    if (v) s.value = v;
                });
            } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    addInvTagRow() {
        try {
            const host = document.getElementById('inv-tags');
            if (!host) return;
            // clone first row options
            const firstSel = host.querySelector('.inv-tag-owner');
            const opts = firstSel ? firstSel.innerHTML : '<option value="">Выберите собственника...</option>';
            const row = document.createElement('div');
            row.className = 'form-group inv-tag-row';
            row.style.display = 'flex';
            row.style.gap = '8px';
            row.style.alignItems = 'center';
            row.innerHTML = `
                <select class="inv-tag-owner" style="flex:1;">${opts}</select>
                <button type="button" class="btn btn-sm btn-danger" onclick="App.removeInvTagRow(this)" title="Удалить бирку"><i class="fas fa-trash"></i></button>
            `;
            host.appendChild(row);
        } catch (_) {}
    },

    removeInvTagRow(btn) {
        try {
            const row = btn?.closest?.('.inv-tag-row');
            if (row) row.remove();
        } catch (_) {}
    },

    async submitInventoryCardCreate(wellId) {
        const wid = parseInt(wellId || 0, 10);
        if (!wid) return;
        try {
            const filled = document.getElementById('inv-filled-date')?.value || '';
            const dirInputs = Array.from(document.querySelectorAll('.inv-dir-count[data-direction-id]'));
            const direction_cables = dirInputs.map(inp => {
                const did = parseInt(inp.getAttribute('data-direction-id') || '0', 10);
                let cnt = parseInt(inp.value || '0', 10);
                if (!Number.isFinite(cnt) || Number.isNaN(cnt)) cnt = 0;
                cnt = Math.max(0, Math.min(100, cnt));
                return { direction_id: did, cable_count: cnt };
            }).filter(x => x.direction_id > 0);

            const tagOwners = Array.from(document.querySelectorAll('#inv-tags .inv-tag-owner'))
                .map(s => parseInt(s.value || '0', 10))
                .filter(v => v > 0);

            const fileInput = document.getElementById('inv-create-attachment-file');
            const files = Array.from(fileInput?.files || []);

            const resp = await API.inventory.createCard({
                well_id: wid,
                filled_date: filled,
                direction_cables,
                tags: tagOwners,
            });
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка', 'error');
                return;
            }
            const card = resp?.data || resp || {};
            const id = parseInt(card?.id || 0, 10);
            if (id && files.length) {
                // Загружаем файлы ПОСЛЕ создания карточки
                for (const f of files) {
                    try { await API.inventory.uploadAttachment(id, f, ''); } catch (_) {}
                }
            }

            this.hideModal();
            this.notify('Инвентарная карточка создана', 'success');
            this.loadObjects();
            if (id) this.openInventoryCard(id);
        } catch (e) {
            this.notify(e?.message || 'Ошибка создания', 'error');
        }
    },

    async openInventoryCard(cardId) {
        if ((this.user?.role?.code || '') === 'readonly') {
            this.notify('Инвентаризация недоступна для роли "Только чтение"', 'error');
            return;
        }
        const id = parseInt(cardId || 0, 10);
        if (!id) return;
        try {
            const resp = await API.inventory.getCard(id);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const card = resp?.data || resp || {};
            const wellId = parseInt(card?.well_id || 0, 10);
            const listResp = wellId ? await API.inventory.byWell(wellId) : { success: true, data: [] };
            const cards = listResp?.data || listResp || [];

            const dirRows = Array.isArray(card.direction_cables) ? card.direction_cables : [];
            const tags = Array.isArray(card.tags) ? card.tags : [];
            const atts = Array.isArray(card.attachments) ? card.attachments : [];

            const content = `
                <div style="display:flex; gap:16px; align-items:flex-start;">
                    <div style="flex: 1 1 auto; min-width: 380px;">
                        <div class="form-group">
                            <label>Номер</label>
                            <input type="text" value="${this.escapeHtml(card.number || '')}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Дата заполнения</label>
                            <input type="date" id="inv-view-filled-date" value="${this.escapeHtml(card.filled_date || '')}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <hr>
                        <h4>Кабели в направлениях</h4>
                        <div style="max-height: 45vh; overflow:auto; padding-right:6px;">
                            ${dirRows.map(r => `
                                <div class="form-group" style="margin-bottom:10px;">
                                    <label>${this.escapeHtml(r.direction_number || r.direction_id)}</label>
                                    <input type="number" value="${Number(r.cable_count || 0)}" disabled style="background: var(--bg-tertiary);">
                                </div>
                            `).join('') || '<div class="text-muted">Нет записей</div>'}
                        </div>
                        <hr>
                        <h4>Обнаруженные бирки</h4>
                        <div>
                            ${tags.map(t => `<div class="text-muted" style="margin-bottom:6px;">${this.escapeHtml(t.owner_name || t.owner_code || t.owner_id)}</div>`).join('') || '<div class="text-muted">Нет</div>'}
                        </div>
                        <hr>
                        <h4>Файлы</h4>
                        <div id="inv-att-list">
                            ${atts.map(a => `
                                <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
                                    <a href="${this.escapeHtml(a.url || '#')}" target="_blank" rel="noopener">${this.escapeHtml(a.original_filename || a.filename || '')}</a>
                                </div>
                            `).join('') || '<div class="text-muted">Нет файлов</div>'}
                        </div>
                    </div>
                    <div style="flex: 0 0 280px; max-width: 280px;">
                        <div class="text-muted" style="margin-bottom:8px;">Карточки колодца</div>
                        <div style="max-height: 65vh; overflow:auto; border:1px solid var(--border-color); border-radius:6px; padding:8px;">
                            ${(cards || []).map(c => {
                                const isActive = Number(c.id) === Number(id);
                                return `
                                    <button class="btn btn-block ${isActive ? 'btn-primary' : 'btn-secondary'}" style="margin-bottom:8px;" onclick="App.openInventoryCard(${Number(c.id)})">
                                        ${this.escapeHtml(c.number || c.id)}<br>
                                        <span class="text-muted">${this.escapeHtml(c.filled_date || '')}</span>
                                    </button>
                                `;
                            }).join('') || `<div class="text-muted">Пока нет карточек</div>`}
                        </div>
                    </div>
                </div>
            `;

            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
                ${this.canDelete() ? `<button class="btn btn-danger" onclick="App.deleteInventoryCard(${id})"><i class="fas fa-trash"></i> Удалить</button>` : ''}
                ${this.canWrite() ? `<button class="btn btn-primary" onclick="App.showEditInventoryCardModal(${id})"><i class="fas fa-edit"></i> Редактировать</button>` : ''}
            `;

            this.showModal('Инвентарная карточка', content, footer, { fitContent: true });
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async deleteInventoryCard(id) {
        const cid = parseInt(id || 0, 10);
        if (!cid) return;
        if (!this.canDelete()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (!confirm('Удалить инвентарную карточку?')) return;
        try {
            const resp = await API.inventory.deleteCard(cid);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.hideModal();
            this.notify('Удалено', 'success');
            this.loadObjects();
        } catch (e) {
            this.notify(e?.message || 'Ошибка удаления', 'error');
        }
    },

    async showEditInventoryCardModal(cardId) {
        const id = parseInt(cardId || 0, 10);
        if (!id) return;
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        try {
            const resp = await API.inventory.getCard(id);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const card = resp?.data || resp || {};
            const wellId = parseInt(card?.well_id || 0, 10);

            const [dirsResp, ownersResp, cardsResp] = await Promise.all([
                API.inventory.wellDirections(wellId),
                API.references.all('owners'),
                API.inventory.byWell(wellId).catch(() => ({ success: true, data: [] })),
            ]);
            const dirs = dirsResp?.data || dirsResp || [];
            const owners = ownersResp?.data || ownersResp || [];
            const cards = cardsResp?.data || cardsResp || [];

            const existing = new Map((Array.isArray(card.direction_cables) ? card.direction_cables : []).map(r => [Number(r.direction_id), Number(r.cable_count || 0)]));
            const existingTags = (Array.isArray(card.tags) ? card.tags : []).map(t => Number(t.owner_id || 0)).filter(x => x > 0);
            const atts = Array.isArray(card.attachments) ? card.attachments : [];

            const ownersOptions = `<option value="">Выберите собственника...</option>` +
                (owners || []).map(o => `<option value="${o.id}">${this.escapeHtml(o.name || o.code || o.id)}</option>`).join('');

            const directionsRows = (dirs || []).map(d => {
                const did = Number(d.id || 0);
                const v = Math.max(0, Math.min(100, Number(existing.get(did) ?? 0) || 0));
                const label = `${d.number || did} (${d.start_well_number || d.start_well_id || '-'} → ${d.end_well_number || d.end_well_id || '-'})`;
                return `
                    <div class="form-group" style="margin-bottom:10px;">
                        <label>${this.escapeHtml(label)}</label>
                        <input type="number" class="inv-dir-count" data-direction-id="${did}" min="0" max="100" value="${v}">
                    </div>
                `;
            }).join('');

            const tagsRows = (existingTags.length ? existingTags : [null]).map(() => `
                <div class="form-group inv-tag-row" style="display:flex; gap:8px; align-items:center;">
                    <select class="inv-tag-owner" style="flex:1;">${ownersOptions}</select>
                    <button type="button" class="btn btn-sm btn-danger" onclick="App.removeInvTagRow(this)" title="Удалить бирку"><i class="fas fa-trash"></i></button>
                </div>
            `).join('');

            const content = `
                <div style="display:flex; gap:16px; align-items:flex-start;">
                    <div style="flex: 1 1 auto; min-width: 380px;">
                        <div class="form-group">
                            <label>Номер</label>
                            <input type="text" value="${this.escapeHtml(card.number || '')}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Дата заполнения</label>
                            <input type="date" id="inv-filled-date" value="${this.escapeHtml(card.filled_date || '')}">
                        </div>
                        <hr>
                        <h4>Кабели в направлениях колодца</h4>
                        <div style="max-height: 45vh; overflow:auto; padding-right:6px;">
                            ${directionsRows || '<div class="text-muted">У колодца нет направлений</div>'}
                        </div>
                        <hr>
                        <h4>Обнаруженные бирки</h4>
                        <div id="inv-tags">${tagsRows}</div>
                        <button type="button" class="btn btn-sm btn-secondary" onclick="App.addInvTagRow()">
                            <i class="fas fa-plus"></i> Добавить бирку
                        </button>

                        <hr>
                        <h4>Файлы</h4>
                        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                            <input type="file" id="inv-attachment-file">
                            <button type="button" class="btn btn-sm btn-secondary" onclick="App.uploadInventoryAttachment(${id})"><i class="fas fa-upload"></i> Загрузить</button>
                        </div>
                        <div>
                            ${atts.map(a => `
                                <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
                                    <a href="${this.escapeHtml(a.url || '#')}" target="_blank" rel="noopener" style="flex:1;">${this.escapeHtml(a.original_filename || a.filename || '')}</a>
                                    ${this.canDelete() ? `<button type="button" class="btn btn-sm btn-danger" onclick="App.deleteInventoryAttachment(${id}, ${Number(a.id)})" title="Удалить файл"><i class="fas fa-trash"></i></button>` : ''}
                                </div>
                            `).join('') || '<div class="text-muted">Нет файлов</div>'}
                        </div>
                    </div>

                    <div style="flex: 0 0 280px; max-width: 280px;">
                        <div class="text-muted" style="margin-bottom:8px;">Карточки колодца</div>
                        <div style="max-height: 65vh; overflow:auto; border:1px solid var(--border-color); border-radius:6px; padding:8px;">
                            ${(cards || []).map(c => {
                                const isActive = Number(c.id) === Number(id);
                                return `
                                    <button class="btn btn-block ${isActive ? 'btn-primary' : 'btn-secondary'}" style="margin-bottom:8px;" onclick="App.openInventoryCard(${Number(c.id)})">
                                        ${this.escapeHtml(c.number || c.id)}<br>
                                        <span class="text-muted">${this.escapeHtml(c.filled_date || '')}</span>
                                    </button>
                                `;
                            }).join('') || `<div class="text-muted">Пока нет карточек</div>`}
                        </div>
                    </div>
                </div>
            `;
            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
                <button class="btn btn-primary" onclick="App.submitInventoryCardUpdate(${id}, ${wellId})"><i class="fas fa-save"></i> Сохранить</button>
            `;
            this.showModal('Инвентарная карточка — редактирование', content, footer, { fitContent: true });
            // fill tag selects
            try {
                const sels = Array.from(document.querySelectorAll('#inv-tags .inv-tag-owner'));
                sels.forEach((s, idx) => {
                    const v = existingTags[idx] ? String(existingTags[idx]) : '';
                    if (v) s.value = v;
                });
            } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async submitInventoryCardUpdate(cardId, wellId) {
        const id = parseInt(cardId || 0, 10);
        if (!id) return;
        try {
            const filled = document.getElementById('inv-filled-date')?.value || '';
            const dirInputs = Array.from(document.querySelectorAll('.inv-dir-count[data-direction-id]'));
            const direction_cables = dirInputs.map(inp => {
                const did = parseInt(inp.getAttribute('data-direction-id') || '0', 10);
                let cnt = parseInt(inp.value || '0', 10);
                if (!Number.isFinite(cnt) || Number.isNaN(cnt)) cnt = 0;
                cnt = Math.max(0, Math.min(100, cnt));
                return { direction_id: did, cable_count: cnt };
            }).filter(x => x.direction_id > 0);

            const tagOwners = Array.from(document.querySelectorAll('#inv-tags .inv-tag-owner'))
                .map(s => parseInt(s.value || '0', 10))
                .filter(v => v > 0);

            const resp = await API.inventory.updateCard(id, {
                filled_date: filled,
                direction_cables,
                tags: tagOwners,
            });
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.hideModal();
            this.notify('Сохранено', 'success');
            this.loadObjects();
            this.openInventoryCard(id);
        } catch (e) {
            this.notify(e?.message || 'Ошибка сохранения', 'error');
        }
    },

    async uploadInventoryAttachment(cardId) {
        const id = parseInt(cardId || 0, 10);
        if (!id) return;
        try {
            const input = document.getElementById('inv-attachment-file');
            const file = input?.files?.[0] || null;
            if (!file) {
                this.notify('Выберите файл', 'warning');
                return;
            }
            const resp = await API.inventory.uploadAttachment(id, file, '');
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Файл загружен', 'success');
            this.showEditInventoryCardModal(id);
        } catch (e) {
            this.notify(e?.message || 'Ошибка загрузки', 'error');
        }
    },

    async deleteInventoryAttachment(cardId, attachmentId) {
        const cid = parseInt(cardId || 0, 10);
        const aid = parseInt(attachmentId || 0, 10);
        if (!cid || !aid) return;
        if (!this.canDelete()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (!confirm('Удалить файл?')) return;
        try {
            const resp = await API.inventory.deleteAttachment(aid);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Файл удалён', 'success');
            this.showEditInventoryCardModal(cid);
        } catch (e) {
            this.notify(e?.message || 'Ошибка удаления файла', 'error');
        }
    },

    async recalculateCableLengths() {
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (this.currentTab !== 'unified_cables') {
            this.switchTab('unified_cables');
        }
        if (!confirm('Пересчитать длины всех кабелей в канализации по маршрутам?')) return;
        try {
            this.notify('Пересчёт длины кабелей...', 'info');
            const resp = await API.unifiedCables.recalculateLengths();
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка пересчёта', 'error');
                return;
            }
            const meta = resp?.data || resp || {};
            const cnt = meta?.cables_total ?? meta?.updated ?? null;
            this.notify(`Длины пересчитаны${cnt !== null ? ` (кабелей: ${cnt})` : ''}`, 'success');
            // Обновим список и суммы
            this.loadObjects();
            try { MapManager.loadAllLayers?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка пересчёта', 'error');
        }
    },

    async recalculateInventoryUnaccounted() {
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (this.currentTab !== 'wells') {
            this.switchTab('wells');
        }
        if (!confirm('Пересчитать неучтенные кабели (Инвентаризация) по текущим кабелям в направлениях?')) return;
        try {
            this.notify('Пересчёт неучтенных кабелей...', 'info');
            const resp = await API.inventory.recalculateUnaccounted();
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка пересчёта', 'error');
                return;
            }
            const meta = resp?.data || resp || {};
            const cnt = meta?.updated ?? null;
            this.notify(`Неучтенные пересчитаны${cnt !== null ? ` (направлений: ${cnt})` : ''}`, 'success');
            this.loadObjects();
            try { MapManager.loadAllLayers?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка пересчёта', 'error');
        }
    },

    async recalculateWellOwnerCodeInNumber() {
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (this.currentTab !== 'wells') {
            this.switchTab('wells');
        }
        if (!confirm('Актуализировать код собственника в номере для ВСЕХ колодцев?')) return;
        try {
            this.notify('Обновление номеров колодцев...', 'info');
            const resp = await API.wells.recalculateOwnerCodeInNumber();
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка обновления', 'error');
                return;
            }
            const meta = resp?.data || resp || {};
            const cnt = meta?.updated ?? null;
            this.notify(`Номера колодцев обновлены${cnt !== null ? ` (колодцев: ${cnt})` : ''}`, 'success');
            this.loadObjects();
            try { MapManager.loadAllLayers?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка обновления номеров колодцев', 'error');
        }
    },

    async recalculateDirectionNames() {
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (this.currentTab !== 'directions') {
            this.switchTab('directions');
        }
        if (!confirm('Обновить имена (номера) ВСЕХ направлений: <начальный>-<конечный>?')) return;
        try {
            this.notify('Обновление направлений...', 'info');
            const resp = await API.channelDirections.recalculateNames();
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка обновления', 'error');
                return;
            }
            const meta = resp?.data || resp || {};
            const cnt = meta?.updated ?? null;
            this.notify(`Направления обновлены${cnt !== null ? ` (направлений: ${cnt})` : ''}`, 'success');
            this.loadObjects();
            try { MapManager.loadAllLayers?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка обновления направлений', 'error');
        }
    },

    async rebuildAssumedCables() {
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (!confirm('Пересчитать предполагаемые кабели (варианты 1/2/3) по данным инвентаризации?')) return;
        try {
            this.notify('Пересчёт предполагаемых кабелей...', 'info');
            const resp = await API.assumedCables.rebuild();
            if (resp?.success === false) {
                this.notify(resp?.message || 'Ошибка пересчёта', 'error');
                return;
            }
            this.notify('Предполагаемые кабели пересчитаны', 'success');
            try {
                const invOn = !!document.getElementById('layer-inventory')?.checked;
                if (invOn && this.assumedCablesModeEnabled) {
                    MapManager.loadAssumedCablesLayer?.();
                    MapManager.refreshAssumedCablesPanel?.();
                }
            } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка пересчёта', 'error');
        }
    },

    initSidebarResize() {
        try {
            if (this._sidebarResizeBound) return;
            this._sidebarResizeBound = true;
        } catch (_) {}

        const sidebar = document.querySelector('.sidebar');
        const handle = document.getElementById('sidebar-resizer');
        if (!sidebar || !handle) return;

        // На узких экранах (мобильное меню) ресайз отключаем
        const isMobile = () => window.innerWidth <= 768;

        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        const applyWidth = (w) => {
            document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
            try { localStorage.setItem('igs_sidebar_width', String(w)); } catch (_) {}
            try { MapManager?.map?.invalidateSize?.({ pan: false, animate: false }); } catch (_) {}
        };

        let dragging = false;
        let startX = 0;
        let startW = 0;
        let lastW = null;

        const onMove = (e) => {
            if (!dragging) return;
            const dx = (e?.clientX ?? 0) - startX;
            const minW = 240;
            const maxW = Math.min(900, Math.floor(window.innerWidth * 0.7));
            const w = clamp(Math.round(startW + dx), minW, maxW);
            if (lastW === w) return;
            lastW = w;
            applyWidth(w);
        };

        const onUp = async () => {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove('sidebar-resizing');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);

            // Сохраняем в персональные настройки (один раз по окончании drag)
            try {
                const w = lastW;
                if (Number.isFinite(w) && w >= 220) {
                    const resp = await API.settings.update({ sidebar_width: String(w) });
                    if (resp?.success !== false) {
                        this.settings.sidebar_width = String(w);
                    }
                }
            } catch (_) {
                // ignore
            }
        };

        handle.addEventListener('mousedown', (e) => {
            if (isMobile()) return;
            if (e.button !== 0) return;
            try { e.preventDefault(); } catch (_) {}

            dragging = true;
            document.body.classList.add('sidebar-resizing');
            const rect = sidebar.getBoundingClientRect();
            startW = rect.width;
            startX = e.clientX;
            lastW = Math.round(startW);

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    },

    async loadObjectsListFilters(tab) {
        const typeSelect = document.getElementById('objects-filter-type');
        const ownerSelect = document.getElementById('objects-filter-owner');
        if (!typeSelect || !ownerSelect) return;

        // если уже заполнено — не перезагружаем
        if (ownerSelect.options.length > 1 && typeSelect.options.length > 1 && typeSelect.dataset?.forTab === tab) return;

        typeSelect.dataset.forTab = tab;
        typeSelect.innerHTML = '<option value="">Вид объекта: все</option>';
        ownerSelect.innerHTML = '<option value="">Собственник: все</option>';

        try {
            const [ownersResp, typesResp, kindsResp] = await Promise.all([
                API.references.all('owners'),
                API.references.all('object_types'),
                API.references.all('object_kinds'),
            ]);

            if (ownersResp?.success) {
                ownerSelect.innerHTML = '<option value="">Собственник: все</option>' +
                    ownersResp.data.map(o => `<option value="${o.id}">${this.escapeHtml(o.name || '')}</option>`).join('');
            }

            const objectTypes = typesResp?.data || [];
            const kinds = kindsResp?.data || [];

            // Для вкладок: фильтр "Вид объекта" трактуем как "Тип" (object_kinds) для конкретного вида (object_types.code)
            let objTypeCode = '';
            if (tab === 'wells') objTypeCode = 'well';
            else if (tab === 'directions') objTypeCode = 'channel';
            else if (tab === 'channels') objTypeCode = 'channel';
            else if (tab === 'markers') objTypeCode = 'marker';

            const ot = (objectTypes || []).find(t => String(t.code || '') === objTypeCode);
            const otId = ot?.id;
            const filteredKinds = otId ? (kinds || []).filter(k => String(k.object_type_id) === String(otId)) : [];
            filteredKinds.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));

            typeSelect.innerHTML = '<option value="">Вид объекта: все</option>' +
                filteredKinds.map(k => `<option value="${k.id}">${this.escapeHtml(k.name || '')}</option>`).join('');
        } catch (_) {
            // ignore
        }
    },

    async loadCableListFilters() {
        const typeSelect = document.getElementById('cables-filter-object-type');
        const ownerSelect = document.getElementById('cables-filter-owner');
        const contractSelect = document.getElementById('cables-filter-contract');
        if (!typeSelect || !ownerSelect || !contractSelect) return;

        // Уже загружено
        if (typeSelect.options.length > 1 && ownerSelect.options.length > 1 && contractSelect.options.length > 1) return;

        try {
            const [typesResp, ownersResp, contractsResp] = await Promise.all([
                API.unifiedCables.objectTypes(),
                API.references.all('owners'),
                API.references.all('contracts'),
            ]);
            if (typesResp?.success) {
                typeSelect.innerHTML = '<option value="">Вид объекта: все</option>' +
                    typesResp.data.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
            }
            if (ownersResp?.success) {
                ownerSelect.innerHTML = '<option value="">Собственник: все</option>' +
                    ownersResp.data.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
            }
            if (contractsResp?.success) {
                const isReadonly = (this.user?.role?.code || '') === 'readonly';
                const userOwnerId = parseInt(this.user?.owner_id || 0, 10) || 0;
                const list = isReadonly && userOwnerId
                    ? (contractsResp.data || []).filter(c => String(c.owner_id || '') === String(userOwnerId))
                    : (contractsResp.data || []);
                contractSelect.innerHTML = '<option value="">Контракт: все</option>' +
                    list.map(c => `<option value="${c.id}">${c.number} — ${c.name}</option>`).join('');
            }
        } catch (e) {
            // ignore
        }
    },

    /**
     * Загрузка объектов
     */
    async loadObjects() {
        const search = document.getElementById('search-objects').value.trim();
        const params = {
            page: this.pagination.page,
            limit: this.pagination.limit,
        };

        // Сортировка (A-Z / Z-A) — бэкенд сортирует по основному полю таба
        if (this.objectsOrder) {
            params.order = this.objectsOrder;
        }
        
        // Добавляем search только если он не пустой
        if (search) {
            params.search = search;
        }

        // Доп. фильтры для списка кабелей
        if (this.currentTab === 'unified_cables') {
            const ot = document.getElementById('cables-filter-object-type')?.value;
            const owner = document.getElementById('cables-filter-owner')?.value;
            const contract = document.getElementById('cables-filter-contract')?.value;
            if (ot) params.object_type_id = ot;
            if (owner) params.owner_id = owner;
            if (contract) params.contract_id = contract;
        } else if (this.currentTab !== 'groups') {
            // Общие фильтры по вкладкам (кроме кабелей/ТУ)
            const owner = document.getElementById('objects-filter-owner')?.value;
            const kind = document.getElementById('objects-filter-type')?.value;
            if (owner) params.owner_id = owner;
            if (this.currentTab === 'wells') {
                const hasInv = !!document.getElementById('wells-filter-has-inventory')?.checked;
                if (hasInv) params.has_inventory = 1;
                const needRefine = !!document.getElementById('wells-filter-coords-needs-refine')?.checked;
                if (needRefine) params.coords_needs_refine = 1;
            }
            if (kind) {
                // Для большинства вкладок фильтруем по kind_id (object_kinds)
                if (this.currentTab === 'wells' || this.currentTab === 'markers' || this.currentTab === 'channels') {
                    params.kind_id = kind;
                } else if (this.currentTab === 'directions') {
                    // У направлений нет kind_id — используем type_id (object_types), но список формируется из object_kinds,
                    // поэтому здесь фильтр не применяем.
                }
            }
        }

        try {
            let response;
            let columns;

            switch (this.currentTab) {
                case 'wells':
                    response = await API.wells.list(params);
                    columns = ['number', 'type_name', 'kind_name', 'status_name', 'owner_short'];
                    break;
                case 'directions':
                    response = await API.channelDirections.list(params);
                    columns = ['number', 'start_well_number', 'end_well_number', 'channel_count', 'owner_name'];
                    break;
                case 'channels':
                    response = await API.cableChannels ? await API.cableChannels.list(params) : { data: [], success: true };
                    columns = ['channel_number', 'direction_number', 'kind_name', 'status_name'];
                    break;
                case 'markers':
                    response = await API.markerPosts.list(params);
                    columns = ['number', 'type_name', 'status_name', 'owner_name'];
                    break;
                case 'unified_cables':
                    response = await API.unifiedCables.list(params);
                    columns = ['number', 'cable_type_name', 'object_type_name', 'owner_name', 'length_calculated'];
                    break;
                case 'cables':
                    response = await API.cables.list('ground', params);
                    columns = ['number', 'type_name', 'status_name', 'fiber_count', 'length_m'];
                    break;
                case 'groups':
                    response = await API.groups.list(params);
                    columns = ['number', 'name', 'tu_date', 'request_basis', 'object_count', 'group_type'];
                    break;
            }

            console.log('loadObjects response:', response);
            
            if (response && response.success !== false) {
                const data = response.data || response;
                console.log('Rendering objects:', data.length, 'items');
                this.renderObjectsTable(data, columns);
                if (response.pagination) {
                    this.pagination = response.pagination;
                    this.renderPagination();
                }

                // Итоги по кабелям (по текущему фильтру/поиску, независимо от страницы)
                if (this.currentTab === 'unified_cables') {
                    const statsParams = { ...params };
                    delete statsParams.page;
                    delete statsParams.limit;
                    try {
                        const statsResp = await API.unifiedCables.stats(statsParams);
                        if (statsResp?.success) {
                            const count = statsResp.data?.count ?? 0;
                            const sum = statsResp.data?.length_sum ?? 0;
                            const countEl = document.getElementById('cables-count');
                            const sumEl = document.getElementById('cables-length-sum');
                            if (countEl) countEl.textContent = String(count);
                            if (sumEl) sumEl.textContent = Number(sum).toFixed(2);
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                // Итоги по прочим вкладкам объектов (справа от фильтров)
                try {
                    await this.updateObjectsTotalsForTab(this.currentTab, params, response);
                } catch (_) {}
            } else {
                console.error('API returned error:', response);
                this.notify('Ошибка загрузки данных', 'error');
            }
        } catch (error) {
            console.error('Ошибка загрузки объектов:', error);
            this.notify('Ошибка загрузки данных', 'error');
        }
    },

    async updateObjectsTotalsForTab(tab, params, response) {
        const el = document.getElementById('objects-totals');
        if (!el) return;

        // Пусто для вкладок, где общий фильтр скрыт
        if (tab === 'unified_cables' || tab === 'groups') {
            el.innerHTML = '';
            return;
        }

        // Базовый total берём из пагинации ответа
        const total = Number(response?.pagination?.total ?? this.pagination?.total ?? 0) || 0;

        if (tab === 'directions') {
            const statsParams = { ...(params || {}) };
            delete statsParams.page;
            delete statsParams.limit;
            try {
                const statsResp = await API.channelDirections.stats(statsParams);
                if (statsResp?.success === false) throw new Error(statsResp?.message || 'Ошибка');
                const data = statsResp?.data || statsResp || {};
                const cnt = Number(data.count ?? total ?? 0) || 0;
                const sum = Number(data.length_sum ?? 0) || 0;
                el.innerHTML = `
                    <span>Кол-во направлений: <strong>${cnt}</strong></span>
                    <span>Общая протяженность (м): <strong>${sum.toFixed(2)}</strong></span>
                `;
                return;
            } catch (_) {
                // fallback
                el.innerHTML = `<span>Кол-во направлений: <strong>${total}</strong></span>`;
                return;
            }
        }

        if (tab === 'wells') {
            el.innerHTML = `<span>Кол-во объектов колодцы: <strong>${total}</strong></span>`;
            return;
        }
        if (tab === 'channels') {
            el.innerHTML = `<span>Кол-во объектов каналы: <strong>${total}</strong></span>`;
            return;
        }
        if (tab === 'markers') {
            el.innerHTML = `<span>Кол-во объектов столбики: <strong>${total}</strong></span>`;
            return;
        }

        // default
        el.innerHTML = `<span>Количество: <strong>${total}</strong></span>`;
    },

    /**
     * Отрисовка таблицы объектов
     */
    renderObjectsTable(data, columns) {
        const header = document.getElementById('table-header');
        const body = document.getElementById('table-body');

        const columnNames = {
            number: 'Номер',
            type_name: 'Вид',
            kind_name: 'Тип',
            status_name: 'Статус',
            owner_name: 'Собственник',
            owner_short: 'Собственник',
            start_well_number: 'Начало',
            end_well_number: 'Конец',
            channel_count: 'Каналов',
            channel_number: '№ канала',
            direction_number: 'Направление',
            fiber_count: 'Волокон',
            length_m: 'Длина (м)',
            length_calculated: 'Длина расч. (м)',
            length_declared: 'Длина заявл. (м)',
            name: 'Название',
            object_count: 'Объектов',
            group_type: 'Тип',
            tu_date: 'Дата',
            request_basis: 'Основание (Запрос)',
            cable_type_name: 'Тип кабеля',
            object_type_name: 'Вид объекта',
            cable_marking: 'Маркировка',
        };

        // Сбрасываем выбор при перерисовке списка
        this.selectedObjectIds.clear();
        this.updateBulkDeleteButton();

        const canBulkDelete = this.canDelete();

        // Заголовок
        header.innerHTML =
            (canBulkDelete ? `<th class="obj-select-col" style="width: 34px;"><input type="checkbox" id="select-all-objects"></th>` : '') +
            columns.map(col => `<th>${columnNames[col] || col}</th>`).join('') +
            '<th>Действия</th>';

        // Тело таблицы
        body.innerHTML = data.map(row => `
            <tr data-id="${row.id}">
                ${canBulkDelete ? `<td class="obj-select-col"><input type="checkbox" class="obj-select" data-id="${row.id}"></td>` : ''}
                ${columns.map(col => `<td>${row[col] || '-'}</td>`).join('')}
                <td>
                    ${Number(row.photo_count || 0) > 0 ? `
                        <button class="btn btn-sm btn-secondary" onclick="App.showAttachedPhotos(${row.id})" title="Посмотреть прикреплённые фото">
                            <i class="fas fa-images"></i>
                        </button>
                    ` : ''}
                    ${this.currentTab === 'wells' ? `
                        ${(Number(row.inventory_cards_count || 0) > 0 && Number(row.last_inventory_card_id || 0) > 0) ? `
                            <button class="btn btn-sm btn-secondary" onclick="App.openInventoryCard(${Number(row.last_inventory_card_id)})" title="Открыть последнюю инвентарную карточку">
                                <i class="fas fa-clipboard-list"></i>
                            </button>
                        ` : ``}
                        ${this.canWrite() ? `
                            <button class="btn btn-sm btn-secondary" onclick="App.showAddInventoryCardModal(${Number(row.id)})" title="Добавить инвентарную карточку">
                                <i class="fas fa-plus"></i>
                            </button>
                        ` : ``}
                    ` : ``}
                    ${this.currentTab === 'channels' ? '' : `
                        <button class="btn btn-sm btn-secondary" onclick="App.viewObject(${row.id})" title="Показать на карте">
                            <i class="fas fa-eye"></i>
                        </button>
                    `}
                    ${this.canWrite() ? `
                        <button class="btn btn-sm btn-primary" onclick="App.editObject(${row.id})" title="Редактировать">
                            <i class="fas fa-edit"></i>
                        </button>
                    ` : ''}
                    ${this.canDelete() ? `
                        ${this.currentTab === 'channels' ? `
                            ${(Number(row.channel_number || 0) === Number(row.max_channel_number || -1)) ? `
                                <button class="btn btn-sm btn-danger" onclick="App.deleteObject('${this.currentTab}', ${row.id})" title="Удалить">
                                    <i class="fas fa-trash"></i>
                                </button>
                            ` : ``}
                        ` : `
                            <button class="btn btn-sm btn-danger" onclick="App.deleteObject('${this.currentTab}', ${row.id})" title="Удалить">
                                <i class="fas fa-trash"></i>
                            </button>
                        `}
                    ` : ''}
                </td>
            </tr>
        `).join('');
    },

    updateBulkDeleteButton() {
        const btn = document.getElementById('btn-delete-selected');
        if (!btn) return;
        const count = this.selectedObjectIds?.size || 0;
        const can = this.canDelete();
        btn.classList.toggle('hidden', !can || count === 0);
        btn.innerHTML = `<i class="fas fa-trash"></i> Удалить выбранные${count ? ` (${count})` : ''}`;
    },

    async deleteSelectedObjects() {
        if (!this.canDelete()) {
            this.notify('Недостаточно прав для удаления', 'error');
            return;
        }
        let ids = Array.from(this.selectedObjectIds || []);
        if (!ids.length) return;

        if (!confirm(`Удалить выбранные записи (${ids.length})?`)) return;

        const results = { ok: 0, failed: 0, errors: [] };

        // Для "Каналы" удаляем строго с последнего в каждом направлении
        if (this.currentTab === 'channels') {
            try {
                const details = [];
                for (const id of ids) {
                    const resp = await API.cableChannels.get(id);
                    const ch = resp?.data || resp;
                    if (ch && ch.id) details.push(ch);
                }
                // Группируем по направлению и сортируем по номеру канала DESC
                details.sort((a, b) => {
                    const da = Number(a.direction_id || 0);
                    const db = Number(b.direction_id || 0);
                    if (da !== db) return da - db;
                    return Number(b.channel_number || 0) - Number(a.channel_number || 0);
                });
                ids = details.map(d => d.id);
            } catch (_) {
                // если не удалось получить детали — оставим исходный порядок
            }
        }

        for (const id of ids) {
            try {
                await this.deleteObjectByTab(id);
                results.ok += 1;
            } catch (e) {
                results.failed += 1;
                results.errors.push({ id, message: e?.message || 'Ошибка' });
            }
        }

        this.selectedObjectIds.clear();
        this.updateBulkDeleteButton();

        if (results.failed) {
            this.notify(`Удалено: ${results.ok}, ошибок: ${results.failed}`, 'warning');
            console.error('Bulk delete errors:', results.errors);
        } else {
            this.notify(`Удалено: ${results.ok}`, 'success');
        }

        this.loadObjects();
        try { MapManager.loadAllLayers(); } catch (_) {}
    },

    deleteObjectByTab(id) {
        switch (this.currentTab) {
            case 'wells':
                return API.wells.delete(id);
            case 'directions':
                return API.channelDirections.delete(id);
            case 'channels':
                return API.cableChannels.delete(id);
            case 'markers':
                return API.markerPosts.delete(id);
            case 'unified_cables':
                return API.unifiedCables.delete(id);
            case 'groups':
                return API.groups.delete(id);
            default:
                return Promise.reject(new Error('Неизвестный тип объекта'));
        }
    },

    getPhotosObjectTable(tab) {
        const map = {
            wells: 'wells',
            directions: 'channel_directions',
            channels: 'cable_channels',
            markers: 'marker_posts',
            unified_cables: 'cables',
        };
        return map[tab] || null;
    },

    async showAttachedPhotos(objectId) {
        const table = this.getPhotosObjectTable(this.currentTab);
        if (!table) {
            this.notify('Для этого типа объектов фотографии недоступны', 'warning');
            return;
        }
        try {
            const resp = await API.photos.byObject(table, objectId);
            if (!resp?.success) {
                this.notify(resp?.message || 'Ошибка загрузки фото', 'error');
                return;
            }
            const photos = resp.data || [];
            if (!photos.length) {
                this.notify('Фотографии не найдены', 'info');
                return;
            }
            this._photoGallery = {
                table,
                objectId,
                photos,
                title: 'Прикреплённые фотографии',
            };
            this.showPhotoGallery();
        } catch (e) {
            this.notify('Ошибка загрузки фото', 'error');
        }
    },

    showPhotoGallery() {
        const ctx = this._photoGallery;
        if (!ctx || !ctx.photos?.length) return;

        const content = `
            <div class="photo-gallery-grid">
                ${ctx.photos.map((p, idx) => `
                    <div class="photo-thumb" onclick="App.openGalleryPhoto(${idx})" title="Открыть">
                        <img src="${p.thumbnail_url || p.url}" alt="${this.escapeHtml(p.original_filename || p.filename || 'Фото')}">
                        <div class="photo-thumb-meta">
                            <div class="photo-thumb-name">${this.escapeHtml(p.original_filename || p.filename || 'Фото')}</div>
                            ${p.description ? `<div class="photo-thumb-desc">${this.escapeHtml(p.description)}</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
        `;
        this.showModal(ctx.title || 'Фотографии', content, footer);
    },

    openGalleryPhoto(index) {
        const ctx = this._photoGallery;
        const p = ctx?.photos?.[index];
        if (!p) return;
        ctx.activeIndex = index;

        const filename = this.escapeHtml(p.original_filename || p.filename || 'photo');
        const img = `
            <div class="photo-viewer">
                <img src="${p.url}" alt="${filename}">
                ${p.description ? `<div class="text-muted" style="margin-top:10px;">${this.escapeHtml(p.description)}</div>` : ''}
            </div>
        `;
        const footer = `
            <a class="btn btn-secondary" href="${p.url}" download="${filename}" target="_blank" rel="noopener">
                <i class="fas fa-download"></i> Скачать
            </a>
            <button class="btn btn-secondary" onclick="App.showPhotoGallery()">Назад</button>
            <button class="btn btn-primary" onclick="App.hideModal()">Закрыть</button>
        `;
        this.showModal(filename, img, footer);
    },

    /**
     * Отрисовка пагинации
     */
    renderPagination() {
        const container = document.getElementById('pagination');
        const { page, pages, total } = this.pagination;

        let html = '';

        const limit = parseInt(this.pagination.limit || 50, 10) || 50;
        const order = (this.objectsOrder === 'desc') ? 'desc' : 'asc';
        const limits = [20, 50, 100, 200];
        const limitOptions = limits.map(v => `<option value="${v}" ${v === limit ? 'selected' : ''}>${v}</option>`).join('');
        const orderOptions = `
            <option value="asc" ${order === 'asc' ? 'selected' : ''}>A-Z</option>
            <option value="desc" ${order === 'desc' ? 'selected' : ''}>Z-A</option>
        `;
        
        if (page > 1) {
            html += `<button type="button" onclick="App.goToPage(${page - 1}); return false;"><i class="fas fa-chevron-left"></i></button>`;
        }

        for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) {
            html += `<button type="button" class="${i === page ? 'active' : ''}" onclick="App.goToPage(${i}); return false;">${i}</button>`;
        }

        if (page < pages) {
            html += `<button type="button" onclick="App.goToPage(${page + 1}); return false;"><i class="fas fa-chevron-right"></i></button>`;
        }

        container.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <div style="display:flex; gap:6px; align-items:center;">
                    ${html}
                </div>
                <div style="margin-left:auto; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                    <label style="display:flex; align-items:center; gap:6px; color: var(--text-secondary);">
                        Сортировка
                        <select id="objects-order-select" onchange="App.setObjectsOrder(this.value)">
                            ${orderOptions}
                        </select>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; color: var(--text-secondary);">
                        На странице
                        <select id="objects-limit-select" onchange="App.setObjectsLimit(this.value)">
                            ${limitOptions}
                        </select>
                    </label>
                </div>
            </div>
        `;
    },

    setObjectsLimit(value) {
        const v = parseInt(value || 50, 10);
        if (!v || v < 1) return;
        this.pagination.limit = v;
        this.pagination.page = 1;
        this.loadObjects();
    },

    setObjectsOrder(value) {
        const v = (String(value || 'asc').toLowerCase() === 'desc') ? 'desc' : 'asc';
        this.objectsOrder = v;
        this.pagination.page = 1;
        this.loadObjects();
    },

    /**
     * Переход на страницу
     */
    goToPage(page) {
        const p = parseInt(page, 10);
        if (!p || p < 1) return;
        if (this.pagination?.pages && p > this.pagination.pages) return;
        this.pagination.page = p;
        this.loadObjects();
    },

    /**
     * Поиск объектов
     */
    handleSearch(query) {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.pagination.page = 1;
            this.loadObjects();
        }, 300);
    },

    /**
     * Просмотр объекта на карте
     */
    async viewObject(id) {
        // Показываем объект на карте с правильным типом
        await MapManager.showObjectOnMap(this.currentTab, id);
    },

    /**
     * Редактирование объекта
     */
    async editObject(id) {
        this.showEditObjectModal(this.currentTab, id);
    },

    /**
     * Показ модального окна редактирования объекта
     */
    async showEditObjectModal(type, id) {
        try {
            let response;
            let title = 'Редактирование объекта';
            
            // Загружаем данные объекта
            switch (type) {
                case 'wells':
                    response = await API.wells.get(id);
                    title = 'Редактирование колодца';
                    break;
                case 'directions':
                    response = await API.channelDirections.get(id);
                    title = 'Редактирование направления';
                    break;
                case 'channels':
                    response = await API.cableChannels.get(id);
                    title = 'Редактирование канала';
                    break;
                case 'markers':
                    response = await API.markerPosts.get(id);
                    title = 'Редактирование столбика';
                    break;
                case 'cables':
                    response = await API.cables.get('ground', id);
                    title = 'Редактирование кабеля';
                    break;
                case 'unified_cables':
                    response = await API.unifiedCables.get(id);
                    title = 'Редактирование кабеля';
                    break;
                case 'groups':
                    response = await API.groups.get(id);
                    title = 'Редактировать карточку ТУ';
                    break;
            }

            if (!response || response.success === false) {
                this.notify('Ошибка загрузки объекта', 'error');
                return;
            }

            const obj = response.data || response;
            // Разбор номера на части для UI (seq + suffix). Формат: <code>-<owner>-<seq>(-<suffix>)
            const _numParts = String(obj?.number || '').split('-');
            const _numSeq = (_numParts.length >= 3 ? (_numParts[2] || '') : '').toString();
            const _numSuffix = (_numParts.length >= 4 ? (_numParts[3] || '') : '').toString();
            // Предвыбор каналов маршрута для duct-кабеля (используется при рендере формы)
            this._editCableRouteChannelIds = [];
            if (type === 'unified_cables' && obj.object_type_code === 'cable_duct' && Array.isArray(obj.route_channels)) {
                this._editCableRouteChannelIds = obj.route_channels.map(rc => parseInt(rc.cable_channel_id));
            }
            // Предзаполнение координат для ground/aerial
            this._editCableCoords = [];
            if (type === 'unified_cables' && (obj.object_type_code === 'cable_ground' || obj.object_type_code === 'cable_aerial') && obj.geometry) {
                try {
                    const geom = typeof obj.geometry === 'string' ? JSON.parse(obj.geometry) : obj.geometry;
                    const coords = geom?.coordinates;
                    if (geom?.type === 'MultiLineString' && Array.isArray(coords) && Array.isArray(coords[0])) {
                        this._editCableCoords = coords[0].map(p => [p[0], p[1]]);
                    }
                } catch (e) {
                    // ignore
                }
            }
            
            // Загружаем список групп для возможности добавления объекта в группы
            const groupsResponse = await API.groups.list({ limit: 100 });
            const groups = groupsResponse.data || groupsResponse || [];

            let formHtml = '';

            if (type === 'wells') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <div class="form-group">
                            <label style="display:flex; align-items:center; gap:8px; font-weight:600;">
                                <input type="hidden" name="coords_needs_refine" value="0">
                                <input type="checkbox" name="coords_needs_refine" value="1" ${obj.coords_needs_refine ? 'checked' : ''}>
                                Требуется уточнить координаты
                            </label>
                        </div>
                        <div class="form-group">
                            <label>Номер *</label>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <input type="text" id="modal-number-prefix" readonly style="flex: 0 0 240px; background: var(--bg-tertiary);" value="...">
                                <input type="text" id="modal-number-seq-preview" disabled style="flex: 0 0 110px; background: var(--bg-tertiary);" value="${this.escapeHtml(_numSeq || 'Авто')}">
                                <input type="text" name="number_suffix" id="modal-number-suffix" maxlength="5" placeholder="Суффикс (до 5)" style="flex: 1;" value="${this.escapeHtml(_numSuffix || '')}">
                            </div>
                            <p class="text-muted">При смене собственника обновляется код собственника в номере. Суффикс можно изменить.</p>
                        </div>
                        <div id="coords-wgs84-inputs">
                            <div class="form-group">
                                <label>Широта (WGS84)</label>
                                <input type="number" name="latitude" step="0.000001" value="${obj.latitude || ''}">
                            </div>
                            <div class="form-group">
                                <label>Долгота (WGS84)</label>
                                <input type="number" name="longitude" step="0.000001" value="${obj.longitude || ''}">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Собственник *</label>
                            <select name="owner_id" required id="modal-owner-select" data-value="${obj.owner_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Вид *</label>
                            <select name="type_id" required id="modal-type-select" data-value="${obj.type_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Тип *</label>
                            <select name="kind_id" required id="modal-kind-select" data-value="${obj.kind_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Состояние *</label>
                            <select name="status_id" required id="modal-status-select" data-value="${obj.status_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>
                    </form>
                `;
            } else if (type === 'markers') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <div class="form-group">
                            <label>Номер *</label>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <input type="text" id="modal-number-prefix" readonly style="flex: 0 0 240px; background: var(--bg-tertiary);" value="...">
                                <input type="text" id="modal-number-seq-preview" disabled style="flex: 0 0 110px; background: var(--bg-tertiary);" value="${this.escapeHtml(_numSeq || 'Авто')}">
                                <input type="text" name="number_suffix" id="modal-number-suffix" maxlength="5" placeholder="Суффикс (до 5)" style="flex: 1;" value="${this.escapeHtml(_numSuffix || '')}">
                            </div>
                            <p class="text-muted">При смене собственника обновляется код собственника в номере. Суффикс можно изменить.</p>
                        </div>
                        <div id="coords-wgs84-inputs">
                            <div class="form-group">
                                <label>Широта (WGS84)</label>
                                <input type="number" name="latitude" step="0.000001" value="${obj.latitude || ''}">
                            </div>
                            <div class="form-group">
                                <label>Долгота (WGS84)</label>
                                <input type="number" name="longitude" step="0.000001" value="${obj.longitude || ''}">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Собственник *</label>
                            <select name="owner_id" required id="modal-owner-select" data-value="${obj.owner_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Вид *</label>
                            <select name="type_id" required id="modal-type-select" data-value="${obj.type_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Тип *</label>
                            <select name="kind_id" required id="modal-kind-select" data-value="${obj.kind_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Состояние *</label>
                            <select name="status_id" required id="modal-status-select" data-value="${obj.status_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Дата установки</label>
                            <input type="date" name="installation_date" value="${obj.installation_date || ''}">
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>
                    </form>
                `;
            } else if (type === 'directions') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <div class="form-group">
                            <label>Номер *</label>
                            <input type="text" name="number" value="${obj.number || ''}" required readonly style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Начальный колодец: <strong>${obj.start_well_number || '-'}</strong></label>
                        </div>
                        <div class="form-group">
                            <label>Конечный колодец: <strong>${obj.end_well_number || '-'}</strong></label>
                        </div>
                        <div class="form-group">
                            <label>Собственник</label>
                            <select name="owner_id" id="modal-owner-select" data-value="${obj.owner_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Состояние</label>
                            <select name="status_id" id="modal-status-select" data-value="${obj.status_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Длина (м)</label>
                            <input type="number" name="length_m" step="0.01" value="${obj.length_m || ''}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>
                        <hr>
                        <h4>Каналы (${obj.channels ? obj.channels.length : 0} из 16)</h4>
                        <div id="channels-list" style="max-height: 200px; overflow-y: auto;">
                            ${(() => {
                                const channels = (obj.channels || []).slice().sort((a, b) => (a.channel_number || 0) - (b.channel_number || 0));
                                const lastNumber = channels.length ? channels[channels.length - 1].channel_number : null;
                                return channels.length > 0 ? channels.map(ch => `
                                    <div class="channel-item" style="padding: 8px; border-bottom: 1px solid var(--border-color); display:flex; gap:8px; align-items:center;">
                                        <button type="button" class="btn btn-sm btn-primary" title="Редактировать канал" onclick="App.showEditObjectModal('channels', ${ch.id})">
                                            <i class="fas fa-edit"></i>
                                        </button>
                                        ${lastNumber !== null && ch.channel_number === lastNumber ? `
                                            <button type="button" class="btn btn-sm btn-danger" title="Удалить канал" onclick="App.deleteLastChannelFromDirection(${obj.id}, ${ch.id})">
                                                <i class="fas fa-trash"></i>
                                            </button>
                                        ` : `<span style="width:34px;"></span>`}
                                        <div style="flex:1;">
                                            <strong>Канал ${ch.channel_number}</strong>: ${ch.kind_name || '-'} / ${ch.status_name || '-'}
                                        </div>
                                    </div>
                                `).join('') : '<p class="text-muted">Каналы не добавлены</p>';
                            })()}
                        </div>
                        <button type="button" class="btn btn-sm btn-secondary" onclick="App.showAddChannelToDirection(${obj.id})" style="margin-top: 8px;">
                            <i class="fas fa-plus"></i> Добавить канал
                        </button>
                    </form>
                `;
            } else if (type === 'channels') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <div class="form-group">
                            <label>Направление</label>
                            <input type="text" value="${obj.direction_number || obj.direction_id || '-'}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Номер канала</label>
                            <input type="text" value="${obj.channel_number || '-'}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Тип</label>
                            <select name="kind_id" id="modal-kind-select" data-value="${obj.kind_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Состояние</label>
                            <select name="status_id" id="modal-status-select" data-value="${obj.status_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Диаметр (мм)</label>
                            <input type="number" name="diameter_mm" value="${obj.diameter_mm || ''}">
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>
                    </form>
                `;
            } else if (type === 'unified_cables') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <input type="hidden" name="object_type_code" value="${obj.object_type_code || ''}">
                        <div class="form-group">
                            <label>Номер *</label>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <input type="text" id="modal-number-prefix" readonly style="flex: 0 0 260px; background: var(--bg-tertiary);" value="...">
                                <input type="text" id="modal-number-seq-preview" disabled style="flex: 0 0 110px; background: var(--bg-tertiary);" value="${this.escapeHtml(_numSeq || 'Авто')}">
                                <input type="text" name="number_suffix" id="modal-number-suffix" maxlength="5" placeholder="Суффикс (до 5)" style="flex: 1;" value="${this.escapeHtml(_numSuffix || '')}">
                            </div>
                            <p class="text-muted">При смене собственника обновляется код собственника в номере. Суффикс можно изменить.</p>
                        </div>
                        <!-- hidden select нужен, чтобы пересчитывать префикс номера по number_code (как в форме создания) -->
                        <select id="modal-cable-object-type" data-value="${obj.object_type_id || ''}" style="display:none;"></select>
                        <div class="form-group">
                            <label>Длина расч. (м)</label>
                            <input type="number" value="${obj.length_calculated || ''}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Вид объекта</label>
                            <input type="text" value="${obj.object_type_name || obj.object_type_code || '-'}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Тип кабеля</label>
                            <select name="cable_type_id" id="modal-cable-type-select" data-value="${obj.cable_type_id || ''}" onchange="App.onCableTypeChange()">
                                <option value="">Выберите тип...</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Кабель (из каталога)</label>
                            <select name="cable_catalog_id" id="modal-cable-catalog-select" data-value="${obj.cable_catalog_id || ''}">
                                <option value="">Выберите марку кабеля...</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Собственник</label>
                            <select name="owner_id" id="modal-owner-select" data-value="${obj.owner_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Состояние</label>
                            <select name="status_id" id="modal-status-select" data-value="${obj.status_id || ''}"></select>
                        </div>
                        <div class="form-group">
                            <label>Контракт</label>
                            <select name="contract_id" id="modal-contract-select" data-value="${obj.contract_id || ''}">
                                <option value="">Не указан</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Дата установки</label>
                            <input type="date" name="installation_date" value="${obj.installation_date || ''}">
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>

                        <div id="cable-geometry-block" style="display: none;">
                            <div class="form-group">
                                <label>Координаты (точки ломаной)</label>
                                <div id="cable-coordinates-list"></div>
                                <button type="button" class="btn btn-sm btn-secondary" onclick="App.addCableCoordinate()">
                                    <i class="fas fa-plus"></i> Добавить точку
                                </button>
                            </div>
                        </div>

                        <div id="cable-route-block" style="display: none;">
                            <div class="form-group">
                                <label>Каналы маршрута</label>
                                <select multiple id="cable-route-channels" style="height: 120px; width: 100%;"></select>
                                <p class="text-muted">Удерживайте Ctrl для выбора нескольких</p>
                            </div>
                        </div>
                    </form>
                `;
            } else if (type === 'groups') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <div class="form-group">
                            <label>Номер</label>
                            <input type="text" name="number" value="${obj.number || obj.id || ''}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Дата</label>
                            <input type="date" name="tu_date" value="${obj.tu_date || ''}">
                        </div>
                        <div class="form-group">
                            <label>Название *</label>
                            <input type="text" name="name" value="${obj.name || ''}" required>
                        </div>
                        <div class="form-group">
                            <label>Основание (Запрос)</label>
                            <input type="text" name="request_basis" maxlength="100" value="${obj.request_basis || ''}">
                        </div>
                        <div class="form-group">
                            <label>Тип ТУ</label>
                            <input type="text" name="group_type" value="${obj.group_type || ''}">
                        </div>
                        <div class="form-group">
                            <label>Описание</label>
                            <textarea name="description" rows="3">${obj.description || ''}</textarea>
                        </div>
                        <hr>
                        <h4>Объекты в ТУ (${obj.objects ? obj.objects.length : 0})</h4>
                        <div id="group-objects-list" style="max-height: 200px; overflow-y: auto;">
                            ${obj.objects && obj.objects.length > 0 ? obj.objects.map(o => `
                                <div class="group-object-item" style="padding: 4px 8px; display: flex; justify-content: space-between; align-items: center;">
                                    <span>${this.getObjectTypeName(o.object_type)}: ${o.number || o.id}</span>
                                    <button type="button" class="btn btn-sm btn-danger" onclick="App.removeObjectFromGroup(${obj.id}, '${o.object_type}', ${o.id})">
                                        <i class="fas fa-times"></i>
                                    </button>
                                </div>
                            `).join('') : '<p class="text-muted">Объекты не добавлены</p>'}
                        </div>
                        <button type="button" class="btn btn-sm btn-secondary" onclick="App.showAddObjectToGroup(${obj.id})" style="margin-top: 8px;">
                            <i class="fas fa-plus"></i> Добавить объекты
                        </button>
                        <button type="button" class="btn btn-sm btn-primary" onclick="App.startGroupPickOnMap(${obj.id})" style="margin-top: 8px; margin-left: 8px;">
                            <i class="fas fa-crosshairs"></i> Указать объект на карте
                        </button>
                        <hr>
                        <h4>Вложения (файлы)</h4>
                        <div id="tu-attachments" data-group-id="${obj.id}">
                            <div class="text-muted">Загрузка...</div>
                        </div>
                        <div class="form-group" style="margin-top: 10px;">
                            <label>Добавить файл</label>
                            <input type="file" id="tu-attachment-file">
                            <input type="text" id="tu-attachment-description" placeholder="Описание (необязательно)" style="margin-top: 8px;">
                            <button type="button" class="btn btn-sm btn-secondary" onclick="App.uploadGroupAttachment(${obj.id})" style="margin-top: 8px;">
                                <i class="fas fa-upload"></i> Загрузить
                            </button>
                        </div>
                    </form>
                `;
            }

            // Фото для объектов (редактирование)
            const photosTableMap = {
                wells: 'wells',
                directions: 'channel_directions',
                channels: 'cable_channels',
                markers: 'marker_posts',
                unified_cables: 'cables',
            };
            const photoTable = photosTableMap[type];
            if (photoTable && formHtml.includes('</form>')) {
                formHtml = formHtml.replace(
                    '</form>',
                    `
                        <hr>
                        <h4>Фото</h4>
                        <div id="object-photos" data-object-table="${photoTable}" data-object-id="${obj.id}">
                            <div class="text-muted">Загрузка...</div>
                        </div>
                        <div class="form-group" style="margin-top: 10px;">
                            <label>Добавить фото</label>
                            <input type="file" id="object-photo-file" accept="image/*">
                            <input type="text" id="object-photo-description" placeholder="Описание (необязательно)" style="margin-top: 8px;">
                            <button type="button" class="btn btn-sm btn-secondary" onclick="App.uploadObjectPhoto()" style="margin-top: 8px;">
                                <i class="fas fa-upload"></i> Загрузить
                            </button>
                        </div>
                    </form>
                    `
                );
            }

            // ТУ, в которые входит объект (read-only)
            if (type !== 'groups' && formHtml.includes('</form>')) {
                formHtml = formHtml.replace(
                    '</form>',
                    `
                        <hr>
                        <h4>ТУ</h4>
                        <div class="form-group">
                            <label>Входит в ТУ</label>
                            <div id="edit-object-groups" class="text-muted">Загрузка...</div>
                        </div>
                    </form>
                    `
                );
            }

            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-danger" onclick="App.deleteObject('${type}', ${id})" style="margin-right: auto;">
                    <i class="fas fa-trash"></i> Удалить
                </button>
                <button class="btn btn-primary" onclick="App.submitEditObject('${type}', ${id})">Сохранить</button>
            `;

            this.showModal(title, formHtml, footer);
            
            // Загружаем справочники и устанавливаем значения
            await this.loadModalSelectsWithValues(type);

            // Инициализация UI номера (суффикс/префикс) для объектов с авто-нумерацией
            try {
                if (type === 'wells') {
                    this.setupWellEditNumberValidation?.(id);
                }
            } catch (_) {}

            // Подгружаем фотографии (если блок есть)
            if (photoTable) {
                this.loadObjectPhotos(photoTable, obj.id).catch(() => {});
            }

            // Подгружаем вложения ТУ (если блок есть)
            if (type === 'groups') {
                this.loadGroupAttachments(id).catch(() => {});
            }

            // Подгружаем группы (если блок есть)
            if (type !== 'groups') {
                this.loadObjectGroupsIntoEditForm(type, id).catch(() => {});
            }
            
        } catch (error) {
            console.error('Ошибка загрузки объекта:', error);
            this.notify('Ошибка загрузки данных', 'error');
        }
    },

    async loadObjectPhotos(objectTable, objectId) {
        const container = document.getElementById('object-photos');
        if (!container) return;
        container.innerHTML = `<div class="text-muted">Загрузка...</div>`;

        const resp = await API.photos.byObject(objectTable, objectId);
        if (!resp?.success) {
            container.innerHTML = `<div class="text-muted">Не удалось загрузить фото</div>`;
            return;
        }
        const photos = resp.data || [];
        if (!photos.length) {
            container.innerHTML = `<div class="text-muted">Фотографий нет</div>`;
            return;
        }

        container.innerHTML = `
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                ${photos.map(p => `
                    <div style="width:120px;">
                        <a href="${p.url}" target="_blank" rel="noopener">
                            <img src="${p.thumbnail_url || p.url}" alt="" style="width:120px; height:120px; object-fit:cover; border-radius:6px; border:1px solid var(--border-color);">
                        </a>
                        <div class="text-muted" style="font-size:12px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${p.description || ''}
                        </div>
                        <button type="button" class="btn btn-sm btn-danger" style="margin-top:6px; width:100%; justify-content:center;" onclick="App.deleteObjectPhoto(${p.id})">
                            <i class="fas fa-trash"></i> Удалить
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    },

    async uploadObjectPhoto() {
        const block = document.getElementById('object-photos');
        const fileInput = document.getElementById('object-photo-file');
        if (!block || !fileInput) return;
        const objectTable = block.dataset.objectTable;
        const objectId = block.dataset.objectId;
        const file = fileInput.files?.[0];
        const desc = document.getElementById('object-photo-description')?.value || '';
        if (!objectTable || !objectId || !file) {
            this.notify('Выберите файл', 'warning');
            return;
        }
        try {
            const resp = await API.photos.upload(objectTable, objectId, file, desc);
            if (resp?.success) {
                fileInput.value = '';
                const d = document.getElementById('object-photo-description');
                if (d) d.value = '';
                this.notify('Фотография загружена', 'success');
                await this.loadObjectPhotos(objectTable, objectId);
            } else {
                this.notify(resp?.message || 'Ошибка загрузки фото', 'error');
            }
        } catch (e) {
            this.notify('Ошибка загрузки фото', 'error');
        }
    },

    async deleteObjectPhoto(photoId) {
        if (!confirm('Удалить фотографию?')) return;
        const block = document.getElementById('object-photos');
        const objectTable = block?.dataset.objectTable;
        const objectId = block?.dataset.objectId;
        try {
            const resp = await API.photos.delete(photoId);
            if (resp?.success) {
                this.notify('Фотография удалена', 'success');
                if (objectTable && objectId) {
                    await this.loadObjectPhotos(objectTable, objectId);
                }
            } else {
                this.notify(resp?.message || 'Ошибка удаления', 'error');
            }
        } catch (e) {
            this.notify('Ошибка удаления', 'error');
        }
    },

    // ========================
    // ТУ: вложения (файлы)
    // ========================

    async loadGroupAttachments(groupId) {
        const container = document.getElementById('tu-attachments');
        if (!container) return;
        container.innerHTML = `<div class="text-muted">Загрузка...</div>`;

        try {
            const resp = await API.groups.attachments(groupId);
            if (!resp?.success) {
                container.innerHTML = `<div class="text-muted">Не удалось загрузить файлы</div>`;
                return;
            }
            const items = resp.data || [];
            if (!items.length) {
                container.innerHTML = `<div class="text-muted">Файлов нет</div>`;
                return;
            }

            const canDel = this.canDelete();
            container.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${items.map(a => `
                        <div style="display:flex; align-items:center; gap:10px; border:1px solid var(--border-color); border-radius:8px; padding:8px 10px;">
                            <div style="flex:1; min-width:0;">
                                <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                    ${this.escapeHtml(a.original_filename || a.filename || '')}
                                </div>
                                <div class="text-muted" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                    ${(a.description ? this.escapeHtml(a.description) : '')}
                                    ${(a.uploaded_by_login ? ` • ${this.escapeHtml(a.uploaded_by_login)}` : '')}
                                </div>
                            </div>
                            <a class="btn btn-sm btn-secondary" href="${a.url}" target="_blank" rel="noopener" download="${this.escapeHtml(a.original_filename || a.filename || 'file')}">
                                <i class="fas fa-download"></i>
                            </a>
                            ${canDel ? `
                                <button type="button" class="btn btn-sm btn-danger" onclick="App.deleteGroupAttachment(${a.id}, ${groupId})" title="Удалить">
                                    <i class="fas fa-trash"></i>
                                </button>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (e) {
            container.innerHTML = `<div class="text-muted">Не удалось загрузить файлы</div>`;
        }
    },

    async uploadGroupAttachment(groupId) {
        const fileInput = document.getElementById('tu-attachment-file');
        const descInput = document.getElementById('tu-attachment-description');
        const file = fileInput?.files?.[0];
        const desc = descInput?.value || '';
        if (!file) {
            this.notify('Выберите файл', 'warning');
            return;
        }
        try {
            const resp = await API.groups.uploadAttachment(groupId, file, desc);
            if (resp?.success) {
                if (fileInput) fileInput.value = '';
                if (descInput) descInput.value = '';
                this.notify('Файл загружен', 'success');
                await this.loadGroupAttachments(groupId);
            } else {
                this.notify(resp?.message || 'Ошибка загрузки файла', 'error');
            }
        } catch (e) {
            this.notify(e?.message || 'Ошибка загрузки файла', 'error');
        }
    },

    async deleteGroupAttachment(attId, groupId) {
        if (!confirm('Удалить файл?')) return;
        try {
            const resp = await API.groups.deleteAttachment(attId);
            if (resp?.success) {
                this.notify('Файл удалён', 'success');
                await this.loadGroupAttachments(groupId);
            } else {
                this.notify(resp?.message || 'Ошибка удаления файла', 'error');
            }
        } catch (e) {
            this.notify(e?.message || 'Ошибка удаления файла', 'error');
        }
    },

    // ========================
    // Карта: режим ТУ
    // ========================

    async openTuModeModal(preselectId = null) {
        try {
            const resp = await API.groups.list({ limit: 1000, page: 1 });
            if (!resp || resp.success === false) {
                this.notify(resp?.message || 'Не удалось загрузить список ТУ', 'error');
                return;
            }
            const list = resp.data || resp || [];
            // Z-A
            list.sort((a, b) => {
                const aa = String(a?.name || a?.number || '').toLowerCase();
                const bb = String(b?.name || b?.number || '').toLowerCase();
                return bb.localeCompare(aa);
            });
            this._tuListCache = list;
            this._tuListSearch = '';
            this._tuListSelectedId = preselectId ? String(preselectId) : (this.tuModeGroupId ? String(this.tuModeGroupId) : null);
            this.renderTuModeModal();
        } catch (e) {
            this.notify('Не удалось загрузить список ТУ', 'error');
        }
    },

    renderTuModeModal() {
        const list = Array.isArray(this._tuListCache) ? this._tuListCache : [];
        const search = String(this._tuListSearch || '').trim().toLowerCase();

        const filtered = !search ? list : list.filter((g) => {
            const hay = [
                g?.number, g?.name, g?.tu_date, g?.request_basis, g?.description, g?.group_type
            ].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(search);
        });

        const current = this.tuModeGroupId ? list.find(x => String(x.id) === String(this.tuModeGroupId)) : null;
        const currentLabel = current ? `${current.number || current.id} — ${current.name || ''}` : 'не выбран';

        const content = `
            <div class="form-group" style="margin-bottom: 10px;">
                <div class="text-muted">Текущий ТУ: <strong>${this.escapeHtml(currentLabel)}</strong></div>
            </div>
            <div class="form-group">
                <label>Поиск</label>
                <input type="text" id="tu-list-search" placeholder="Поиск по всем полям..." value="${this.escapeHtml(this._tuListSearch || '')}">
            </div>
            <div style="border:1px solid var(--border-color); border-radius:10px; overflow:hidden;">
                <div style="max-height: 45vh; overflow:auto; background: rgba(0,0,0,0.08);">
                    ${filtered.length ? filtered.map(g => {
                        const id = String(g.id);
                        const checked = this._tuListSelectedId && String(this._tuListSelectedId) === id ? 'checked' : '';
                        const title = `${g.number || g.id} — ${g.name || ''}`;
                        const sub = [
                            g.tu_date ? `Дата: ${g.tu_date}` : '',
                            g.request_basis ? `Основание: ${g.request_basis}` : '',
                        ].filter(Boolean).join(' • ');
                        return `
                            <label style="display:flex; gap:10px; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.08); cursor:pointer;">
                                <input type="radio" name="tu-select" value="${id}" ${checked} style="margin-top: 2px;">
                                <div style="min-width:0;">
                                    <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(title)}</div>
                                    <div class="text-muted" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(sub)}</div>
                                </div>
                            </label>
                        `;
                    }).join('') : `<div class="text-muted" style="padding:12px;">Нет ТУ</div>`}
                </div>
            </div>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
            ${this.canWrite() ? `<button class="btn btn-secondary" onclick="App.createTuFromTuList()"><i class="fas fa-plus"></i> Создать ТУ</button>` : ''}
            ${this.tuModeEnabled ? `<button class="btn btn-danger" onclick="App.disableTuMode()" style="margin-right:auto;"><i class="fas fa-times"></i> Выключить режим</button>` : `<span style="margin-right:auto;"></span>`}
            <button class="btn btn-primary" onclick="App.selectTuFromTuList()"><i class="fas fa-check"></i> Выбрать ТУ</button>
        `;

        this.showModal('Список карточек ТУ', content, footer);

        const input = document.getElementById('tu-list-search');
        if (input) {
            input.addEventListener('input', (e) => {
                this._tuListSearch = e.target.value || '';
                this.renderTuModeModal();
            });
        }
        document.querySelectorAll('input[name="tu-select"]').forEach((el) => {
            el.addEventListener('change', () => {
                this._tuListSelectedId = el.value;
            });
        });
    },

    createTuFromTuList() {
        this._returnToTuListAfterCreate = true;
        this.showAddObjectModal('groups');
    },

    selectTuFromTuList() {
        const selected = document.querySelector('input[name="tu-select"]:checked');
        const id = selected?.value || this._tuListSelectedId;
        if (!id) {
            this.notify('Выберите ТУ из списка', 'warning');
            return;
        }
        this.tuModeEnabled = true;
        this.tuModeGroupId = parseInt(id, 10);
        document.getElementById('btn-tu-mode')?.classList.toggle('active', true);
        this.notify('Режим ТУ включён', 'success');
        this.hideModal();
    },

    disableTuMode() {
        this.tuModeEnabled = false;
        this.tuModeGroupId = null;
        document.getElementById('btn-tu-mode')?.classList.toggle('active', false);
        this.notify('Режим ТУ выключен', 'info');
        // оставляем модалку открытой
        this.renderTuModeModal();
    },

    /**
     * Загрузка селектов с установкой сохранённых значений
     */
    async loadModalSelectsWithValues(type) {
        await this.loadModalSelects(type);
        
        // Устанавливаем сохранённые значения с небольшой задержкой для гарантии заполнения
        setTimeout(() => {
            // Сначала устанавливаем вид объекта (type_id)
            const typeSelect = document.getElementById('modal-type-select');
            if (typeSelect && typeSelect.dataset.value) {
                typeSelect.value = typeSelect.dataset.value;
                // Обновляем список типов (kinds) для выбранного вида
                if (this.allKinds) {
                    this.filterKindsByType(typeSelect.dataset.value, this.allKinds);
                }
            }
            
            // Затем устанавливаем остальные значения
            const selects = ['modal-owner-select', 'modal-kind-select', 'modal-status-select', 'modal-contract-select', 'modal-cable-object-type', 'modal-cable-type-select', 'modal-cable-catalog-select'];
            selects.forEach(selectId => {
                const select = document.getElementById(selectId);
                if (select && select.dataset.value) {
                    select.value = select.dataset.value;
                    // Важно: после установки owner_id нужно пересчитать префикс/номер по актуальному коду собственника
                    // (иначе остаётся дефолтный код, например "АДМ")
                    if (selectId === 'modal-owner-select') {
                        select.dispatchEvent(new Event('change'));
                    }
                    if (selectId === 'modal-kind-select') {
                        select.dispatchEvent(new Event('change'));
                    }
                }
            });

            // Колодцы: если выбран "ввод в здание" — собственник принудительно "Не указан"
            try { this.enforceInputWellOwnerInModal?.(); } catch (_) {}

            // Для кабелей — после установки типа загружаем каталог и применяем сохранённое значение
            if (type === 'unified_cables' && document.getElementById('modal-cable-type-select')?.value) {
                this.onCableTypeChange().then(() => {
                    const catalogSelect = document.getElementById('modal-cable-catalog-select');
                    if (catalogSelect && catalogSelect.dataset.value) {
                        catalogSelect.value = catalogSelect.dataset.value;
                    }
                });
            }

            // Для кабелей — показываем нужный блок редактирования в зависимости от object_type_code
            if (type === 'unified_cables') {
                const objectTypeCode = document.querySelector('#edit-object-form input[name="object_type_code"]')?.value || '';
                const geomBlock = document.getElementById('cable-geometry-block');
                const routeBlock = document.getElementById('cable-route-block');
                if (objectTypeCode === 'cable_duct') {
                    if (geomBlock) geomBlock.style.display = 'none';
                    if (routeBlock) {
                        routeBlock.style.display = 'block';
                        // Предвыбор каналов из API (включая каналы, которые могут не попасть в limit)
                        const ids = (this._editCableRouteChannelIds || []).map(v => parseInt(v)).filter(v => v > 0);
                        this.loadCableRouteOptions(ids).catch(() => {});
                    }
                } else if (objectTypeCode === 'cable_ground' || objectTypeCode === 'cable_aerial') {
                    if (routeBlock) routeBlock.style.display = 'none';
                    if (geomBlock) geomBlock.style.display = 'block';
                    // Заполняем координаты если есть
                    const container = document.getElementById('cable-coordinates-list');
                    if (container) {
                        container.innerHTML = '';
                        (this._editCableCoords || []).forEach(() => this.addCableCoordinate());
                        const rows = container.querySelectorAll('.cable-coord-row');
                        rows.forEach((row, idx) => {
                            const x = row.querySelector('.coord-x');
                            const y = row.querySelector('.coord-y');
                            const pt = (this._editCableCoords || [])[idx];
                            if (pt && x && y) {
                                x.value = pt[0];
                                y.value = pt[1];
                            }
                        });
                    }
                }
            }
        }, 50);
    },

    /**
     * Колодцы: подсветка/проверка уникальности номера при редактировании
     */
    setupWellEditNumberValidation(wellId) {
        const ownerSelect = document.getElementById('modal-owner-select');
        const prefixInput = document.getElementById('modal-number-prefix');
        const suffixInput = document.getElementById('modal-number-suffix');
        const hint = document.getElementById('well-number-hint');
        if (!suffixInput) return;

        const lightGreen = 'rgba(34, 197, 94, 0.15)';
        const lightRed = 'rgba(239, 68, 68, 0.15)';

        let timer = null;
        let lastChecked = '';

        const setOk = () => {
            suffixInput.style.background = lightGreen;
            if (hint) hint.textContent = '';
            if (suffixInput.setCustomValidity) suffixInput.setCustomValidity('');
        };

        const setBad = () => {
            suffixInput.style.background = lightRed;
            if (hint) hint.textContent = 'Требуется поменять порядковый номер, так как колодец с таким номером уже есть в системе';
            if (suffixInput.setCustomValidity) suffixInput.setCustomValidity('Номер колодца уже существует');
        };

        const clear = () => {
            suffixInput.style.background = '';
            if (hint) hint.textContent = '';
            if (suffixInput.setCustomValidity) suffixInput.setCustomValidity('');
        };

        const buildNumber = () => {
            const prefix = (prefixInput?.value || '').toString();
            const suffix = (suffixInput?.value || '').toString().trim();
            // Разрешаем любые буквы (Unicode) + цифры + подчёркивание.
            // Дефис запрещён (разделитель в номере).
            const cleanSuffix = suffix.replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 5);
            if (!prefix) return '';
            // seq подбирается сервером, поэтому проверяем только суффикс на допустимые символы/длину
            return `${prefix}...${cleanSuffix ? '-' + cleanSuffix : ''}`.trim();
        };

        const check = async () => {
            const number = buildNumber();
            if (!number || number === lastChecked) return;
            lastChecked = number;

            try {
                // seq вычисляется сервером, клиентская проверка полного номера не применяется
                setOk();
            } catch (_) {
                clear();
            }
        };

        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(check, 250);
        };

        // Доп. обработчик поверх существующего (который обновляет префикс)
        if (ownerSelect) ownerSelect.addEventListener('change', schedule);
        suffixInput?.addEventListener('input', schedule);

        // стартовая проверка
        schedule();
    },

    /**
     * Отправка формы редактирования объекта
     */
    async submitEditObject(type, id) {
        const form = document.getElementById('edit-object-form');
        if (form?.reportValidity && !form.reportValidity()) return;
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        delete data.id;

        // Номер пересобирается на сервере из number_seq/number_suffix при необходимости
        
        // Собираем выбранные группы
        const groupCheckboxes = form.querySelectorAll('input[name="group_ids"]:checked');
        const groupIds = Array.from(groupCheckboxes).map(cb => parseInt(cb.value));
        delete data.group_ids;

        try {
            let response;
            
            switch (type) {
                case 'wells':
                    response = await API.wells.update(id, data);
                    break;
                case 'directions':
                    response = await API.channelDirections.update(id, data);
                    break;
                case 'channels':
                    response = await API.cableChannels.update(id, data);
                    break;
                case 'markers':
                    response = await API.markerPosts.update(id, data);
                    break;
                case 'cables':
                    response = await API.cables.update('ground', id, data);
                    break;
                case 'unified_cables':
                    {
                        const objectTypeCode = document.querySelector('#edit-object-form input[name="object_type_code"]')?.value || '';
                        if (objectTypeCode === 'cable_ground' || objectTypeCode === 'cable_aerial') {
                            const coordinates = this.collectCableCoordinates();
                            if (coordinates.length >= 2) {
                                data.coordinates = coordinates;
                                data.coordinate_system = 'wgs84';
                            }
                        } else if (objectTypeCode === 'cable_duct') {
                            const channelsSelect = document.getElementById('cable-route-channels');
                            data.route_channels = Array.from(channelsSelect?.selectedOptions || []).map(o => parseInt(o.value));
                        }
                    }
                    response = await API.unifiedCables.update(id, data);
                    break;
                case 'groups':
                    response = await API.groups.update(id, data);
                    break;
            }

            if (response && response.success) {
                // Добавляем в выбранные группы
                if (groupIds.length > 0 && type !== 'groups') {
                    const objectTypeMap = {
                        'wells': 'well',
                        'markers': 'marker_post',
                        'directions': 'channel_direction',
                    };
                    const objectType = objectTypeMap[type] || type;
                    
                    for (const groupId of groupIds) {
                        await API.groups.addObjects(groupId, [{ type: objectType, id: id }]);
                    }
                }
                
                this.hideModal();
                this.notify('Объект обновлён', 'success');
                this.loadObjects();
                MapManager.loadAllLayers();
            } else {
                this.notify(response?.message || 'Ошибка обновления', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Удаление объекта
     */
    async deleteObject(type, id) {
        if (!confirm('Вы уверены, что хотите удалить этот объект?')) {
            return;
        }

        try {
            let response;
            
            switch (type) {
                case 'wells':
                    response = await API.wells.delete(id);
                    break;
                case 'directions':
                    response = await API.channelDirections.delete(id);
                    break;
                case 'channels':
                    response = await API.cableChannels.delete(id);
                    break;
                case 'markers':
                    response = await API.markerPosts.delete(id);
                    break;
                case 'cables':
                    response = await API.cables.delete('ground', id);
                    break;
                case 'unified_cables':
                    response = await API.unifiedCables.delete(id);
                    break;
                case 'groups':
                    response = await API.groups.delete(id);
                    break;
            }

            if (response && response.success) {
                this.hideModal();
                this.notify('Объект удалён', 'success');
                this.loadObjects();
                MapManager.loadAllLayers();
            } else {
                this.notify(response?.message || 'Ошибка удаления', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Получение названия типа объекта
     */
    getObjectTypeName(type) {
        const names = {
            'well': 'Колодец',
            'channel_direction': 'Направление',
            'cable_channel': 'Канал',
            'marker_post': 'Столбик',
            'ground_cable': 'Кабель в грунте',
            'aerial_cable': 'Воздушный кабель',
            'duct_cable': 'Кабель в канализации',
            'unified_cable': 'Кабель',
        };
        return names[type] || type;
    },

    /**
     * Показ модального окна добавления объектов в группу
     */
    async showAddObjectToGroup(groupId) {
        try {
            // Загружаем списки объектов
            const [wells, directions, channels, markers, unifiedCables] = await Promise.all([
                API.wells.list({ limit: 500 }),
                API.channelDirections.list({ limit: 500 }),
                API.cableChannels.list({ limit: 500 }),
                API.markerPosts.list({ limit: 500 }),
                API.unifiedCables.list({ limit: 500 }),
            ]);

            const content = `
                <form id="add-to-group-form">
                    <div class="form-group">
                        <label>Колодцы</label>
                        <select multiple id="select-wells" style="height: 80px; width: 100%;">
                            ${(wells.data || []).map(w => `<option value="${w.id}">${w.number}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Направления</label>
                        <select multiple id="select-directions" style="height: 80px; width: 100%;">
                            ${(directions.data || []).map(d => `<option value="${d.id}">${d.number}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Каналы</label>
                        <select multiple id="select-channels" style="height: 80px; width: 100%;">
                            ${(channels.data || []).map(c => `<option value="${c.id}">Канал ${c.channel_number} (${c.direction_number || '-'})</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Кабели</label>
                        <select multiple id="select-cables" style="height: 80px; width: 100%;">
                            ${(unifiedCables.data || []).map(c => `<option value="${c.id}">${c.number || c.id} - ${c.cable_type_name || ''}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Столбики</label>
                        <select multiple id="select-markers" style="height: 80px; width: 100%;">
                            ${(markers.data || []).map(m => `<option value="${m.id}">${m.number || m.id}</option>`).join('')}
                        </select>
                    </div>
                    <p class="text-muted">Удерживайте Ctrl для выбора нескольких</p>
                </form>
            `;

            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-primary" onclick="App.submitAddObjectsToGroup(${groupId})">Добавить</button>
            `;

            this.showModal('Добавить объекты в группу', content, footer);
        } catch (error) {
            this.notify('Ошибка загрузки объектов', 'error');
        }
    },

    /**
     * Отправка добавления объектов в группу
     */
    async submitAddObjectsToGroup(groupId) {
        const wellsSelect = document.getElementById('select-wells');
        const directionsSelect = document.getElementById('select-directions');
        const channelsSelect = document.getElementById('select-channels');
        const cablesSelect = document.getElementById('select-cables');
        const markersSelect = document.getElementById('select-markers');

        const objects = [];
        
        if (wellsSelect) {
            Array.from(wellsSelect.selectedOptions).forEach(opt => {
                objects.push({ type: 'well', id: parseInt(opt.value) });
            });
        }
        if (directionsSelect) {
            Array.from(directionsSelect.selectedOptions).forEach(opt => {
                objects.push({ type: 'channel_direction', id: parseInt(opt.value) });
            });
        }
        if (channelsSelect) {
            Array.from(channelsSelect.selectedOptions).forEach(opt => {
                objects.push({ type: 'cable_channel', id: parseInt(opt.value) });
            });
        }
        if (cablesSelect) {
            Array.from(cablesSelect.selectedOptions).forEach(opt => {
                objects.push({ type: 'unified_cable', id: parseInt(opt.value) });
            });
        }
        if (markersSelect) {
            Array.from(markersSelect.selectedOptions).forEach(opt => {
                objects.push({ type: 'marker_post', id: parseInt(opt.value) });
            });
        }

        if (objects.length === 0) {
            this.notify('Выберите объекты', 'warning');
            return;
        }

        try {
            const response = await API.groups.addObjects(groupId, objects);
            if (response.success) {
                this.hideModal();
                this.notify(`Добавлено объектов: ${objects.length}`, 'success');
                this.loadObjects();
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Удаление объекта из группы
     */
    async removeObjectFromGroup(groupId, objectType, objectId) {
        if (!confirm('Удалить объект из группы?')) {
            return;
        }

        try {
            const response = await API.groups.removeObjects(groupId, [{ type: objectType, id: objectId }]);
            if (response.success) {
                this.notify('Объект удалён из группы', 'success');
                // Перезагружаем модальное окно
                this.showEditObjectModal('groups', groupId);
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    startGroupPickOnMap(groupId) {
        this.hideModal();
        this.switchPanel('map');
        MapManager.startGroupPickMode(groupId);
    },

    async addGroupObjectFromMap(groupId, hit) {
        const gid = parseInt(groupId);
        if (!gid || !hit) return;

        const type = hit.objectType;
        const id = parseInt(hit?.properties?.id);
        if (!type || !id) {
            this.notify('Не удалось определить объект', 'error');
            return;
        }

        const allowed = new Set(['well', 'channel_direction', 'marker_post', 'unified_cable']);
        if (!allowed.has(type)) {
            this.notify('Этот тип объекта нельзя добавить в группу с карты', 'warning');
            return;
        }

        try {
            const resp = await API.groups.addObjects(gid, [{ type, id }]);
            if (resp?.success === false) {
                this.notify(resp.message || 'Ошибка добавления', 'error');
                return;
            }
            this.notify('Объект добавлен в группу', 'success');
            // Возвращаем пользователя в карточку группы с обновлённым списком
            this.showEditObjectModal('groups', gid);
        } catch (e) {
            this.notify(e?.message || 'Ошибка добавления', 'error');
        }
    },

    groupObjectTypeForContext(objectTypeOrTab) {
        const map = {
            // map object types
            well: 'well',
            channel_direction: 'channel_direction',
            marker_post: 'marker_post',
            unified_cable: 'unified_cable',
            ground_cable: 'ground_cable',
            aerial_cable: 'aerial_cable',
            duct_cable: 'duct_cable',
            cable_channel: 'cable_channel',

            // tabs/modals
            wells: 'well',
            directions: 'channel_direction',
            markers: 'marker_post',
            unified_cables: 'unified_cable',
            channels: 'cable_channel',
        };
        return map[objectTypeOrTab] || objectTypeOrTab;
    },

    async loadObjectGroupsIntoInfo(objectType, objectId) {
        const panel = document.getElementById('object-info-panel');
        const valueEl = document.getElementById('info-groups');
        if (!panel || !valueEl) return;

        // если пользователь уже выбрал другой объект — не обновляем
        if (String(panel.dataset.objectType) !== String(objectType) || String(panel.dataset.objectId) !== String(objectId)) return;

        const type = this.groupObjectTypeForContext(objectType);
        try {
            const resp = await API.groups.byObject(type, objectId);
            const rows = resp?.data || resp || [];
            const names = (rows || []).map(g => (g.number ? `${g.number} — ${g.name}` : (g.name || g.id))).filter(Boolean);
            valueEl.textContent = names.length ? names.join(', ') : '-';
        } catch (e) {
            valueEl.textContent = '-';
        }
    },

    async loadObjectGroupsIntoEditForm(tabType, objectId) {
        const el = document.getElementById('edit-object-groups');
        if (!el) return;
        const type = this.groupObjectTypeForContext(tabType);
        try {
            const resp = await API.groups.byObject(type, objectId);
            const rows = resp?.data || resp || [];
            const names = (rows || []).map(g => (g.number ? `${g.number} — ${g.name}` : (g.name || g.id))).filter(Boolean);
            el.textContent = names.length ? names.join(', ') : '-';
        } catch (e) {
            el.textContent = '-';
        }
    },

    /**
     * Показ модального окна добавления канала к направлению
     */
    async showAddChannelToDirection(directionId) {
        const content = `
            <form id="add-channel-form">
                <div class="form-group">
                    <label>Номер канала (1-16)</label>
                    <input type="number" name="channel_number" min="1" max="16" placeholder="Авто">
                </div>
                <div class="form-group">
                    <label>Тип</label>
                    <select name="kind_id" id="modal-kind-select"></select>
                </div>
                <div class="form-group">
                    <label>Состояние</label>
                    <select name="status_id" id="modal-status-select"></select>
                </div>
                <div class="form-group">
                    <label>Диаметр (мм)</label>
                    <input type="number" name="diameter_mm" value="110">
                </div>
                <div class="form-group">
                    <label>Примечания</label>
                    <textarea name="notes" rows="2"></textarea>
                </div>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitAddChannel(${directionId})">Добавить</button>
        `;

        this.showModal('Добавить канал', content, footer);
        
        // Загружаем справочники
        await this.loadModalSelects('channels');
    },

    async deleteLastChannelFromDirection(directionId, channelId) {
        if (!confirm('Удалить последний канал?')) return;
        try {
            const resp = await API.cableChannels.delete(channelId);
            if (resp?.success === false) {
                this.notify(resp.message || 'Ошибка удаления канала', 'error');
                return;
            }
            this.notify('Канал удалён', 'success');
            // Обновляем окно редактирования направления
            this.showEditObjectModal('directions', directionId);
        } catch (e) {
            this.notify(e?.message || 'Ошибка удаления канала', 'error');
        }
    },

    /**
     * Отправка добавления канала
     */
    async submitAddChannel(directionId) {
        const form = document.getElementById('add-channel-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

        try {
            const response = await API.channelDirections.addChannel(directionId, data);
            if (response.success) {
                this.hideModal();
                this.notify('Канал добавлен', 'success');
                // Перезагружаем окно редактирования направления
                this.showEditObjectModal('directions', directionId);
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Загрузка инцидентов
     */
    async loadIncidents() {
        const status = document.getElementById('incident-status-filter').value;
        const dateFrom = document.getElementById('incident-date-from').value;
        const dateTo = document.getElementById('incident-date-to').value;

        const params = {};
        if (status) params.status = status;
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;

        try {
            const response = await API.incidents.list(params);
            if (response.success !== false) {
                this.renderIncidents(response.data || response);
            }
        } catch (error) {
            console.error('Ошибка загрузки инцидентов:', error);
        }
    },

    /**
     * Отрисовка инцидентов
     */
    renderIncidents(incidents) {
        const container = document.getElementById('incidents-list');
        
        container.innerHTML = incidents.map(inc => `
            <div class="incident-card" onclick="App.viewIncident(${inc.id})">
                <div class="incident-header">
                    <span class="incident-number">${inc.number}</span>
                    <span class="incident-status ${inc.status}">${this.getStatusName(inc.status)}</span>
                </div>
                <div class="incident-title">${inc.title}</div>
                <div class="incident-meta">
                    <span><i class="fas fa-calendar"></i> ${this.formatDate(inc.incident_date)}</span>
                    <span><i class="fas fa-user"></i> ${inc.created_by_name || inc.created_by_login}</span>
                </div>
            </div>
        `).join('') || '<p style="text-align: center; color: var(--text-muted);">Нет инцидентов</p>';
    },

    /**
     * Получение названия статуса
     */
    getStatusName(status) {
        const names = {
            open: 'Открыт',
            in_progress: 'В работе',
            resolved: 'Решён',
            closed: 'Закрыт',
        };
        return names[status] || status;
    },

    /**
     * Форматирование даты
     */
    formatDate(date) {
        if (!date) return '-';
        return new Date(date).toLocaleDateString('ru-RU');
    },

    escapeHtml(value) {
        return (value ?? '').toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    /**
     * Просмотр инцидента
     */
    async viewIncident(id) {
        try {
            const response = await API.incidents.get(id);
            if (response.success) {
                this.showIncidentModal(response.data);
            }
        } catch (error) {
            this.notify('Ошибка загрузки инцидента', 'error');
        }
    },

    /**
     * Показ отчёта
     */
    async showReport(type) {
        const container = document.getElementById('report-content');
        container.classList.remove('hidden');
        container.innerHTML = '<p>Загрузка...</p>';

        // Инвентаризация: отдельная отрисовка (с фильтром и счётчиком)
        if (type === 'inventory') {
            await this.applyInventoryReportFilter();
            return;
        }

        try {
            let response;
            let html = '';

            switch (type) {
                case 'objects':
                    response = await API.reports.objects();
                    html = this.renderObjectsReport(response.data);
                    break;
                case 'contracts':
                    response = await API.reports.contracts();
                    html = this.renderContractsReport(response.data);
                    break;
                case 'owners':
                    response = await API.reports.owners();
                    html = this.renderOwnersReport(response.data);
                    break;
                case 'incidents':
                    response = await API.reports.incidents();
                    html = this.renderIncidentsReport(response.data);
                    break;
                case 'inventory':
                    // handled выше
                    break;
            }

            const exportBtn = (type === 'incidents')
                ? ''
                : `<button class="btn btn-secondary" onclick="App.showReportExportModal('${type}')">
                        <i class="fas fa-download"></i> Выгрузить отчет
                   </button>`;

            container.innerHTML = `
                <div class="panel-header">
                    <h3>${this.getReportTitle(type)}</h3>
                    ${exportBtn}
                </div>
                ${html}
            `;

            // Если отчёт ниже карточек — прокручиваем до него (теперь #report-content скроллится)
            try {
                container.scrollTop = 0;
                container.scrollIntoView({ block: 'start' });
            } catch (_) {}
        } catch (error) {
            container.innerHTML = '<p style="color: var(--danger-color);">Ошибка загрузки отчёта</p>';
        }
    },

    getReportTitle(type) {
        const titles = {
            objects: 'Отчёт по объектам',
            contracts: 'Отчёт по контрактам',
            owners: 'Отчёт по собственникам',
            incidents: 'Отчёт по инцидентам',
            inventory: 'Отчёт по инвентаризации',
        };
        return titles[type] || 'Отчёт';
    },

    renderInventoryReport(data) {
        const rows = data?.rows || [];
        const owners = data?.owners || [];
        const selectedOwnerId = (data?.selected_owner_id ?? '').toString(); // собственник направления
        const selectedTagOwnerId = (data?.selected_tag_owner_id ?? '').toString(); // собственник бирки
        const confirmTags = !!data?.confirm_tags;
        const esc = (s) => this.escapeHtml((s ?? '').toString());
        const nl = (s) => esc(s).replace(/\n/g, '<br>');
        const fmtLen = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return '-';
            return n.toFixed(2);
        };

        const parseLines = (s) => {
            const x = (s ?? '').toString();
            if (!x.trim()) return [];
            return x.split('\n').map(v => v.toString()).filter(v => v !== '');
        };
        const parseIds = (s) => {
            const x = (s ?? '').toString();
            if (!x.trim()) return [];
            return x.split('\n').map(v => parseInt(v || '0', 10)).map(v => (Number.isFinite(v) ? v : 0));
        };
        const parseIntLines = (s) => parseLines(s).map(v => parseInt(v || '0', 10)).map(v => (Number.isFinite(v) ? v : 0));

        const confirmTagsByCables = (cableOwnerIds, startTagOwnerIds, endTagOwnerIds) => {
            const startUsed = new Array(startTagOwnerIds.length).fill(false);
            const endUsed = new Array(endTagOwnerIds.length).fill(false);
            const startConfirmed = new Set();
            const endConfirmed = new Set();
            const cableConfirmed = new Set(); // idx of cable in list

            const findFirst = (arr, used, ownerId) => {
                for (let i = 0; i < arr.length; i++) {
                    if (used[i]) continue;
                    if ((arr[i] || 0) === ownerId) return i;
                }
                return -1;
            };

            // Важно: учитываем кратность кабелей (owner_id может повторяться в списке кабелей)
            for (let cIdx = 0; cIdx < (cableOwnerIds || []).length; cIdx++) {
                const oid = (cableOwnerIds || [])[cIdx];
                const ownerId = parseInt(oid || 0, 10);
                if (!ownerId) continue;
                const si = findFirst(startTagOwnerIds, startUsed, ownerId);
                const ei = findFirst(endTagOwnerIds, endUsed, ownerId);
                if (si >= 0 && ei >= 0) {
                    startUsed[si] = true;
                    endUsed[ei] = true;
                    startConfirmed.add(si);
                    endConfirmed.add(ei);
                    cableConfirmed.add(cIdx);
                }
            }
            return { startConfirmed, endConfirmed, cableConfirmed };
        };

        const decorateTagsByIndexes = (namesStr, confirmedIdxSet) => {
            const names = parseLines(namesStr);
            if (!names.length) return '';
            const out = names.map((name, idx) => {
                if (confirmedIdxSet && confirmedIdxSet.has(idx)) return `(П) ${name}`;
                return `${name} (НП)`;
            });
            return out.join('\n');
        };

        const decorateCablesByIndexes = (numbersStr, confirmedIdxSet) => {
            const nums = parseLines(numbersStr);
            if (!nums.length) return '';
            const out = nums.map((num, idx) => {
                if (confirmedIdxSet && confirmedIdxSet.has(idx)) return `(П) ${num}`;
                return `${num} (НП)`;
            });
            return out.join('\n');
        };

        return `
            <div class="filters-row" style="margin: 12px 0;">
                <select id="report-inventory-owner">
                    <option value="">Собственник: все</option>
                    ${owners.map(o => `<option value="${o.id}">${esc(o.name || '')}</option>`).join('')}
                </select>
                <select id="report-inventory-tag-owner">
                    <option value="">Бирки: собственник — все</option>
                    ${owners.map(o => `<option value="${o.id}">${esc(o.name || '')}</option>`).join('')}
                </select>
                <label class="text-secondary" style="display:flex; align-items:center; gap:8px; white-space:nowrap;">
                    <input type="checkbox" id="report-inventory-confirm-tags" ${confirmTags ? 'checked' : ''}>
                    <span>Отобразить подтверждение Бирки</span>
                </label>
                <button class="btn btn-primary btn-sm" onclick="App.applyInventoryReportFilterFromUi()">
                    <i class="fas fa-filter"></i> Применить
                </button>
                <button class="btn btn-secondary btn-sm" onclick="App.openInventoryRecommendationsFromInventoryReportUi()">
                    <i class="fas fa-clipboard-list"></i> Рекомендации по инвентаризации по собственнику
                </button>
            </div>
            <div class="text-muted" style="margin: 8px 0 12px 0;">Сортировка: по номеру направления.</div>
            <table>
                <thead>
                    <tr>
                        <th style="width: 50px;">№</th>
                        <th>Номер направления</th>
                        <th>Длина (м)</th>
                        <th>Кабели в направлении</th>
                        <th>Начальный колодец</th>
                        <th>Обнаружено (старт)</th>
                        <th>Бирки (старт)</th>
                        <th>Конечный колодец</th>
                        <th>Обнаружено (конец)</th>
                        <th>Бирки (конец)</th>
                        <th>Неучтённые</th>
                        <th style="width: 140px;">Действия</th>
                    </tr>
                </thead>
                <tbody>
                    ${(rows || []).map((r, idx) => `
                        <tr>
                            <td>${idx + 1}</td>
                            <td>${esc(r.direction_number || r.direction_id || '')}</td>
                            <td>${fmtLen(r.direction_length_m)}</td>
                            <td style="white-space: pre-line;">${(() => {
                                const v = confirmTags ? (() => {
                                    const cableOwners = parseIntLines(r.cable_owner_ids || '');
                                    const sIds = parseIntLines(r.start_tag_owner_ids || '');
                                    const eIds = parseIntLines(r.end_tag_owner_ids || '');
                                    const conf = confirmTagsByCables(cableOwners, sIds, eIds);
                                    return decorateCablesByIndexes(r.cable_numbers || '', conf.cableConfirmed);
                                })() : (r.cable_numbers || '');
                                return nl(v || '') || '-';
                            })()}</td>
                            <td>
                                <div style="display:flex; align-items:center; gap:6px; justify-content:space-between;">
                                    <span>${esc(r.start_well_number || '-')}</span>
                                    ${(r.start_card_id ? `
                                        <button class="btn btn-sm btn-secondary" title="Открыть последнюю инвентарную карточку"
                                                onclick="App.openInventoryCard(${Number(r.start_card_id)})">
                                            <i class="fas fa-clipboard-check"></i>
                                        </button>
                                    ` : ``)}
                                </div>
                            </td>
                            <td>${Number(r.start_inventory_cables || 0)}</td>
                            <td style="white-space: pre-line;">${(() => {
                                const v = confirmTags ? (() => {
                                    const cableOwners = parseIntLines(r.cable_owner_ids || '');
                                    const sIds = parseIntLines(r.start_tag_owner_ids || '');
                                    const eIds = parseIntLines(r.end_tag_owner_ids || '');
                                    const conf = confirmTagsByCables(cableOwners, sIds, eIds);
                                    return decorateTagsByIndexes(r.start_tag_owners || '', conf.startConfirmed);
                                })() : (r.start_tag_owners || '');
                                return nl(v || '') || '-';
                            })()}</td>
                            <td>
                                <div style="display:flex; align-items:center; gap:6px; justify-content:space-between;">
                                    <span>${esc(r.end_well_number || '-')}</span>
                                    ${(r.end_card_id ? `
                                        <button class="btn btn-sm btn-secondary" title="Открыть последнюю инвентарную карточку"
                                                onclick="App.openInventoryCard(${Number(r.end_card_id)})">
                                            <i class="fas fa-clipboard-check"></i>
                                        </button>
                                    ` : ``)}
                                </div>
                            </td>
                            <td>${Number(r.end_inventory_cables || 0)}</td>
                            <td style="white-space: pre-line;">${(() => {
                                const v = confirmTags ? (() => {
                                    const cableOwners = parseIntLines(r.cable_owner_ids || '');
                                    const sIds = parseIntLines(r.start_tag_owner_ids || '');
                                    const eIds = parseIntLines(r.end_tag_owner_ids || '');
                                    const conf = confirmTagsByCables(cableOwners, sIds, eIds);
                                    return decorateTagsByIndexes(r.end_tag_owners || '', conf.endConfirmed);
                                })() : (r.end_tag_owners || '');
                                return nl(v || '') || '-';
                            })()}</td>
                            <td>${Number(r.unaccounted_cables || 0)}</td>
                            <td style="white-space: nowrap;">
                                <button class="btn btn-sm btn-secondary" title="Показать на карте"
                                        onclick="App.showInventoryDirectionOnMap(${Number(r.direction_id)})">
                                    <i class="fas fa-eye"></i>
                                </button>
                                ${this.canWrite() ? `
                                    <button class="btn btn-sm btn-primary" title="Редактировать направление"
                                            onclick="App.editDirectionFromInventoryReport(${Number(r.direction_id)})">
                                        <i class="fas fa-edit"></i>
                                    </button>
                                ` : ``}
                            </td>
                        </tr>
                    `).join('') || '<tr><td colspan="12">Нет данных</td></tr>'}
                </tbody>
            </table>
        `;
    },

    applyInventoryReportFilterFromUi() {
        const ownerId = document.getElementById('report-inventory-owner')?.value || '';
        const tagOwnerId = document.getElementById('report-inventory-tag-owner')?.value || '';
        const confirmTags = !!document.getElementById('report-inventory-confirm-tags')?.checked;
        return this.applyInventoryReportFilter({ ownerId, tagOwnerId, confirmTags });
    },

    openInventoryRecommendationsFromInventoryReportUi() {
        if ((this.user?.role?.code || '') === 'readonly') {
            this.notify('Инвентаризация недоступна для роли "Только чтение"', 'error');
            return;
        }
        const ownerIdRaw = document.getElementById('report-inventory-owner')?.value || '';
        const ownerId = parseInt(ownerIdRaw || '0', 10);
        if (!ownerId) {
            this.notify('Выберите собственника в фильтре отчёта', 'warning');
            return;
        }
        try {
            MapManager?.showInventoryRecommendationsPanel?.(ownerId);
        } catch (_) {
            // fallback: просто переключимся на карту
            try { this.switchPanel('map'); } catch (_) {}
        }
    },

    showInventoryRecommendationsExportModal(ownerId) {
        const oid = parseInt(ownerId || 0, 10);
        if (!oid) {
            this.notify('Не указан собственник', 'warning');
            return;
        }
        this.showCsvDelimiterModal('Выгрузить (рекомендации по инвентаризации)', (delimiter) => {
            return API.reports.export('inventory_recommendations', { owner_id: oid }, delimiter);
        });
    },

    async applyInventoryReportFilter(opts = null) {
        const container = document.getElementById('report-content');
        if (!container) return;
        container.classList.remove('hidden');
        container.innerHTML = '<p>Загрузка...</p>';

        const o = opts || {};
        const oid = (o.ownerId || '').toString().trim();
        const toid = (o.tagOwnerId || '').toString().trim();
        const confirmTags = !!o.confirmTags;
        const params = {};
        if (oid) params.owner_id = oid;
        if (toid) params.tag_owner_id = toid;

        try {
            const [reportResp, ownersResp] = await Promise.all([
                API.reports.inventory(params),
                API.references.all('owners'),
            ]);
            if (reportResp?.success === false) throw new Error(reportResp?.message || 'Ошибка');
            if (ownersResp?.success === false) throw new Error(ownersResp?.message || 'Ошибка');

            const rows = reportResp?.data?.rows || [];
            const owners = ownersResp?.data || [];
            const title = this.getReportTitle('inventory');
            const count = Array.isArray(rows) ? rows.length : 0;

            container.innerHTML = `
                <div class="panel-header">
                    <div style="display:flex; align-items:baseline; gap:12px; min-width:0;">
                        <h3 style="margin:0;">${this.escapeHtml(title)}</h3>
                        <div class="text-muted" style="white-space:nowrap;">Записей: <strong>${count}</strong></div>
                    </div>
                    <button class="btn btn-secondary" onclick="App.showReportExportModal('inventory')">
                        <i class="fas fa-download"></i> Выгрузить отчет
                    </button>
                </div>
                ${this.renderInventoryReport({ rows, owners, selected_owner_id: oid, selected_tag_owner_id: toid, confirm_tags: confirmTags })}
            `;

            // восстановить выбранный фильтр
            const sel = container.querySelector('#report-inventory-owner');
            if (sel) sel.value = oid;
            const sel2 = container.querySelector('#report-inventory-tag-owner');
            if (sel2) sel2.value = toid;
        } catch (e) {
            container.innerHTML = '<p style="color: var(--danger-color);">Ошибка загрузки отчёта</p>';
        }
    },

    async showInventoryDirectionOnMap(directionId) {
        if ((this.user?.role?.code || '') === 'readonly') {
            this.notify('Инвентаризация недоступна для роли "Только чтение"', 'error');
            return;
        }
        const did = parseInt(directionId || 0, 10);
        if (!did) return;
        try {
            // Переходим на карту
            this.switchPanel?.('map');
        } catch (_) {}

        // включаем слой инвентаризации
        try {
            const cb = document.getElementById('layer-inventory');
            if (cb) {
                cb.checked = true;
                this.handleLayerToggle(cb);
            }
        } catch (_) {}

        try {
            await MapManager.showObjectOnMap('channel_direction', did);
        } catch (_) {}
    },

    editDirectionFromInventoryReport(directionId) {
        const did = parseInt(directionId || 0, 10);
        if (!did) return;
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        try {
            this.showEditObjectModal('directions', did);
        } catch (_) {}
    },

    renderObjectsReport(data) {
        // Фильтр по собственнику
        const owners = data?.owners || [];
        const formatLen = (v) => {
            if (v === null || v === undefined || v === '') return '-';
            const n = Number(v);
            if (Number.isNaN(n)) return '-';
            return n.toFixed(2);
        };
        return `
            <div class="filters-row" style="margin: 12px 0;">
                <select id="report-objects-owner">
                    <option value="">Собственник: все</option>
                    ${owners.map(o => `<option value="${o.id}">${o.name}</option>`).join('')}
                </select>
                <button class="btn btn-primary btn-sm" onclick="App.applyObjectsReportFilter()">
                    <i class="fas fa-filter"></i> Применить
                </button>
            </div>
            <table>
                <thead>
                    <tr><th>Тип объекта</th><th>Количество</th><th>Длина (м)</th></tr>
                </thead>
                <tbody>
                    ${data.summary.map(item => `
                        <tr>
                            <td>${item.object_name}</td>
                            <td>${item.count}</td>
                            <td>${formatLen(item.total_length)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    },

    async applyObjectsReportFilter() {
        const ownerId = document.getElementById('report-objects-owner')?.value || '';
        const container = document.getElementById('report-content');
        if (!container) return;
        container.innerHTML = '<p>Загрузка...</p>';
        try {
            const resp = await API.reports.objects(ownerId ? { owner_id: ownerId } : {});
            if (resp?.success) {
                container.innerHTML = `
                    <div class="panel-header">
                        <h3>${this.getReportTitle('objects')}</h3>
                        <button class="btn btn-secondary" onclick="App.showReportExportModal('objects')">
                            <i class="fas fa-download"></i> Выгрузить отчет
                        </button>
                    </div>
                    ${this.renderObjectsReport(resp.data)}
                `;
                // сохраняем выбранное значение
                const sel = container.querySelector('#report-objects-owner');
                if (sel) sel.value = ownerId;
            }
        } catch (e) {
            container.innerHTML = '<p style="color: var(--danger-color);">Ошибка загрузки отчёта</p>';
        }
    },

    renderContractsReport(data) {
        const contracts = data?.contracts || [];
        const selectedId = data?.contract?.id ? String(data.contract.id) : '';

        const contracted = data?.contracted || { stats: { count: 0, length_sum_contract_part: 0, cost_per_meter: null }, cables: [] };
        const uncontracted = data?.uncontracted || { stats: { count: 0, length_sum_contract_part: 0, cost_per_meter: null }, cables: [] };

        const canManage = (typeof this.canWrite === 'function') ? this.canWrite() : false;
        const renderCablesTable = (rows, mode) => `
            <table>
                <thead>
                    <tr>
                        <th>Номер</th>
                        <th>Вид объекта</th>
                        <th>Тип кабеля</th>
                        <th>Кабель (из каталога)</th>
                        <th>Собственник</th>
                        <th>Длина расч. (м), всего кабеля</th>
                        <th>Длина расч. (м) в части контракта</th>
                        <th style="width: 210px;">Действия</th>
                    </tr>
                </thead>
                <tbody>
                    ${(rows || []).map(c => `
                        <tr>
                            <td>${c.number || '-'}</td>
                            <td>${c.object_type_name || '-'}</td>
                            <td>${c.cable_type_name || '-'}</td>
                            <td>${c.marking || '-'}</td>
                            <td>${c.owner_name || '-'}</td>
                            <td>${c.length_calculated || 0}</td>
                            <td>${Number(c.length_contract_part || 0).toFixed(2)}</td>
                            <td style="white-space: nowrap;">
                                <button class="btn btn-sm btn-secondary" title="Показать на карте"
                                        onclick='MapManager.showObjectOnMap("unified_cables", ${Number(c.id)})'>
                                    <i class="fas fa-eye"></i>
                                </button>
                                ${mode === 'uncontracted' ? (canManage ? `
                                    <button class="btn btn-sm btn-primary" title="Добавить в контракт"
                                            onclick='App.addCableToSelectedContractFromReport(${Number(c.id)})'>
                                        <i class="fas fa-plus"></i>
                                    </button>
                                ` : ``) : ``}
                                ${mode === 'contracted' ? (canManage ? `
                                    <button class="btn btn-sm btn-danger" title="Исключить из контракта"
                                            onclick='App.removeCableFromContractFromReport(${Number(c.id)})'>
                                        <i class="fas fa-times"></i>
                                    </button>
                                ` : ``) : ``}
                            </td>
                        </tr>
                    `).join('') || '<tr><td colspan="8">Нет данных</td></tr>'}
                </tbody>
            </table>
        `;

        const green = (v) => `<span style="color: var(--success-color); font-weight: 600;">${v}</span>`;
        const fmt2 = (v) => Number(v || 0).toFixed(2);

        return `
            <div class="filters-row" style="margin: 12px 0;">
                <select id="report-contracts-contract">
                    <option value="">Контракт: выберите...</option>
                    ${contracts.map(c => `<option value="${c.id}">${c.number} — ${c.name}</option>`).join('')}
                </select>
                <button class="btn btn-primary btn-sm" onclick="App.applyContractsReportFilter()">
                    <i class="fas fa-filter"></i> Показать
                </button>
            </div>

            ${selectedId ? `
                <div style="margin-top: 12px;">
                    <h4>
                        Кабеля контракта
                        <span class="text-muted">
                            (Количество кабелей: ${green(contracted.stats.count)},
                            Общая протяженность кабелей (м) в части контракта: ${green(fmt2(contracted.stats.length_sum_contract_part || 0))},
                            Стоимость за 1 метр: ${green(contracted.stats.cost_per_meter === null ? '-' : contracted.stats.cost_per_meter)})
                        </span>
                    </h4>
                    ${renderCablesTable(contracted.cables, 'contracted')}
                </div>

                <div style="margin-top: 18px;">
                    <h4>
                        Не законтрактованные Кабеля собственника контракта
                        <span class="text-muted">
                            (Количество кабелей: ${green(uncontracted.stats.count)},
                            Общая протяженность кабелей (м) в части контракта: ${green(fmt2(uncontracted.stats.length_sum_contract_part || 0))})
                        </span>
                    </h4>
                    ${renderCablesTable(uncontracted.cables, 'uncontracted')}
                </div>
            ` : `
                <p class="text-muted">Выберите контракт в фильтре — после этого будет сформирован отчёт.</p>
            `}
        `;
    },

    async addCableToSelectedContractFromReport(cableId) {
        const contractId = document.getElementById('report-contracts-contract')?.value || '';
        const cid = parseInt(contractId || 0, 10);
        const id = parseInt(cableId || 0, 10);
        if (!id || !cid) {
            this.notify('Выберите контракт', 'warning');
            return;
        }
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        try {
            const resp = await API.unifiedCables.update(id, { contract_id: cid });
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Кабель добавлен в контракт', 'success');
            await this.applyContractsReportFilter();
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async removeCableFromContractFromReport(cableId) {
        const id = parseInt(cableId || 0, 10);
        if (!id) return;
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (!confirm('Исключить кабель из контракта?')) return;
        try {
            const resp = await API.unifiedCables.update(id, { contract_id: null });
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Кабель исключён из контракта', 'success');
            await this.applyContractsReportFilter();
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async applyContractsReportFilter() {
        const contractId = document.getElementById('report-contracts-contract')?.value || '';
        const container = document.getElementById('report-content');
        if (!container) return;
        container.innerHTML = '<p>Загрузка...</p>';
        try {
            const resp = await API.reports.contracts(contractId ? { contract_id: contractId } : {});
            if (resp?.success) {
                container.innerHTML = `
                    <div class="panel-header">
                        <h3>${this.getReportTitle('contracts')}</h3>
                        <button class="btn btn-secondary" onclick="App.showReportExportModal('contracts')">
                            <i class="fas fa-download"></i> Выгрузить отчет
                        </button>
                    </div>
                    ${this.renderContractsReport(resp.data)}
                `;
                const sel = container.querySelector('#report-contracts-contract');
                if (sel) sel.value = contractId;
            }
        } catch (e) {
            container.innerHTML = '<p style="color: var(--danger-color);">Ошибка загрузки отчёта</p>';
        }
    },

    renderOwnersReport(data) {
        return `
            <table>
                <thead>
                    <tr>
                        <th>Собственник</th>
                        <th>Колодцы</th>
                        <th>Направления</th>
                        <th>Направление (м)</th>
                        <th>Столбики</th>
                        <th>Кабели</th>
                        <th>Кабели Длинна (м)</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.map(o => `
                        <tr>
                            <td>${o.name}</td>
                            <td>${o.wells}</td>
                            <td>${o.channel_directions}</td>
                            <td>${Number(o.channel_directions_length_m || 0).toFixed(2)}</td>
                            <td>${o.marker_posts}</td>
                            <td>${o.cables}</td>
                            <td>${Number(o.cables_length_m || 0).toFixed(2)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    },

    renderIncidentsReport(data) {
        return `
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
                <div class="report-card" style="padding: 16px;">
                    <h4>Всего</h4>
                    <div style="font-size: 24px; font-weight: bold;">${data.summary.total}</div>
                </div>
                <div class="report-card" style="padding: 16px;">
                    <h4>Открытых</h4>
                    <div style="font-size: 24px; font-weight: bold; color: var(--danger-color);">${data.summary.open}</div>
                </div>
                <div class="report-card" style="padding: 16px;">
                    <h4>В работе</h4>
                    <div style="font-size: 24px; font-weight: bold; color: var(--warning-color);">${data.summary.in_progress}</div>
                </div>
                <div class="report-card" style="padding: 16px;">
                    <h4>Решённых</h4>
                    <div style="font-size: 24px; font-weight: bold; color: var(--success-color);">${data.summary.resolved}</div>
                </div>
            </div>
            <h4>Последние инциденты</h4>
            <table>
                <thead>
                    <tr><th>Номер</th><th>Название</th><th>Дата</th><th>Статус</th></tr>
                </thead>
                <tbody>
                    ${data.recent.map(i => `
                        <tr>
                            <td>${i.number}</td>
                            <td>${i.title}</td>
                            <td>${this.formatDate(i.incident_date)}</td>
                            <td><span class="incident-status ${i.status}">${this.getStatusName(i.status)}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    },

    /**
     * Показ справочника
     */
    async showReference(type) {
        this.currentReference = type;
        this.lastReferenceInReferencesPanel = type;

        // Справочник display_styles удалён
        if (type === 'display_styles') {
            this.notify('Справочник удалён', 'warning');
            return;
        }

        // Управление справочниками: обычно только админ, но "Контракты" можно и роли "Пользователь"
        const addBtn = document.getElementById('btn-add-ref');
        if (addBtn) {
            addBtn.classList.toggle('hidden', !this.canManageReferenceType(type) || type === 'object_types');
        }
        
        document.querySelector('.references-grid').classList.add('hidden');
        document.getElementById('reference-content').classList.remove('hidden');
        
        const titles = {
            object_types: 'Виды объектов',
            object_kinds: 'Типы объектов',
            object_status: 'Состояния',
            owners: 'Собственники',
            contracts: 'Контракты',
            cable_types: 'Типы кабелей',
            cable_catalog: 'Каталог кабелей',
        };
        
        document.getElementById('ref-title').textContent = titles[type] || type;

        try {
            const response = await API.references.list(type);
            if (response.success !== false) {
                this.renderReferenceTable(response.data || response);
            }
        } catch (error) {
            this.notify('Ошибка загрузки справочника', 'error');
        }
    },

    /**
     * Скрытие справочника
     */
    hideReference() {
        this.currentReference = null;
        document.querySelector('.references-grid').classList.remove('hidden');
        document.getElementById('reference-content').classList.add('hidden');
    },

    async loadContractsPanel() {
        // Контракты — отдельный раздел (не "Справочники")
        this.currentReference = 'contracts';
        const header = document.getElementById('contracts-table-header');
        const body = document.getElementById('contracts-table-body');
        if (!header || !body) return;

        // Кнопка "Добавить" доступна администратору и роли "Пользователь" (при write)
        document.getElementById('btn-add-contract')?.classList.toggle('hidden', !this.canManageReferenceType('contracts'));

        header.innerHTML = '<th>Загрузка...</th>';
        body.innerHTML = `<tr><td>Загрузка...</td></tr>`;

        try {
            const resp = await API.references.list('contracts', { page: 1, limit: 500 });
            const data = resp?.data || [];
            const canManage = this.canManageReferenceType('contracts');

            // Колонки как в справочнике contracts
            const columns = ['number', 'name', 'owner_id', 'landlord_id', 'start_date', 'end_date', 'status', 'amount', 'notes'];
            const labels = {
                number: 'Номер',
                name: 'Название',
                owner_id: 'Арендатор',
                landlord_id: 'Арендодатель',
                start_date: 'Дата начала',
                end_date: 'Дата окончания',
                status: 'Статус',
                amount: 'Сумма',
                notes: 'Примечания',
            };

            header.innerHTML =
                columns.map(c => `<th>${labels[c] || c}</th>`).join('') +
                (canManage ? '<th>Действия</th>' : '');

            const fmt = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));
            const fmtContracts = (col, row) => {
                if (col === 'owner_id') return fmt(row.owner_name || row.owner_id);
                if (col === 'landlord_id') return fmt(row.landlord_name || row.landlord_id);
                return fmt(row[col]);
            };

            body.innerHTML = (data || []).map(row => `
                <tr>
                    ${columns.map(c => `<td>${fmtContracts(c, row)}</td>`).join('')}
                    ${canManage ? `
                        <td>
                            <button class="btn btn-sm btn-primary" onclick="App.editReference(${row.id})" title="Редактировать">
                                <i class="fas fa-edit"></i>
                            </button>
                        </td>
                    ` : ''}
                </tr>
            `).join('') || `<tr><td colspan="${canManage ? columns.length + 1 : columns.length}">Нет данных</td></tr>`;
        } catch (e) {
            header.innerHTML = '<th>Ошибка</th>';
            body.innerHTML = `<tr><td>Ошибка загрузки</td></tr>`;
        }
    },

    showAddContractModal() {
        this.currentReference = 'contracts';
        // Переиспользуем существующую форму справочника
        this.showAddReferenceModal();
    },

    async loadSettingsPanel() {
        // Панель доступна всем пользователям, но набор видимых секций зависит от роли
        await this.loadSettings().catch(() => {});

        const roleCode = (this.user?.role?.code || '').toString();
        const isAdminLike = this.isAdmin() || this.isRoot();
        // По ТЗ:
        // - admin/root: все секции
        // - user: только интерфейс карты + ссылки меню + hotkeys
        // - readonly: панель недоступна (switchPanel принудительно возвращает на карту), но на всякий случай скроем всё
        const hideSection = (id, hide) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.toggle('hidden', !!hide);
            // Скрываем визуальный разделитель (hr) перед секцией, если он есть
            try {
                const prev = el.previousElementSibling;
                if (prev && String(prev.tagName || '').toUpperCase() === 'HR') {
                    prev.classList.toggle('hidden', !!hide);
                }
            } catch (_) {}
        };
        if (roleCode === 'user') {
            hideSection('settings-section-data', true);
            hideSection('settings-section-wmts', true);
        } else if (!isAdminLike) {
            // максимально ограничительный режим для неизвестных ролей
            hideSection('settings-section-data', true);
            hideSection('settings-section-wmts', true);
        } else {
            hideSection('settings-section-data', false);
            hideSection('settings-section-wmts', false);
        }
        if (roleCode === 'readonly') {
            hideSection('settings-section-data', true);
            hideSection('settings-section-ui', true);
            hideSection('settings-section-links', true);
            hideSection('settings-section-wmts', true);
            hideSection('settings-section-hotkeys', true);
        }

        const z = document.getElementById('settings-map-zoom');
        const lat = document.getElementById('settings-map-lat');
        const lng = document.getElementById('settings-map-lng');
        const len = document.getElementById('settings-cable-well-len');
        const wDir = document.getElementById('settings-line-weight-direction');
        const wCable = document.getElementById('settings-line-weight-cable');
        const iconSize = document.getElementById('settings-icon-size-well-marker');
        const fsWell = document.getElementById('settings-font-size-well-number');
        const fsDirLen = document.getElementById('settings-font-size-direction-length');
        const selColor = document.getElementById('settings-selected-object-highlight-color');
        const magnetPx = document.getElementById('settings-magnet-pixels');
        const geo = document.getElementById('settings-url-geoproj');
        const cad = document.getElementById('settings-url-cadastre');
        const wmtsUrlTmpl = document.getElementById('settings-wmts-url-template');
        const wmtsStyle = document.getElementById('settings-wmts-style');
        const wmtsTms = document.getElementById('settings-wmts-tilematrixset');
        const wmtsTm = document.getElementById('settings-wmts-tilematrix');
        const wmtsTr = document.getElementById('settings-wmts-tilerow');
        const wmtsTc = document.getElementById('settings-wmts-tilecol');
        const entryKind = document.getElementById('settings-well-entry-kind-code');
        const poleKind = document.getElementById('settings-well-pole-kind-code');
        const inbuildingStatus = document.getElementById('settings-direction-inbuilding-status-code');
        const hkDir = document.getElementById('settings-hotkey-add-direction');
        const hkWell = document.getElementById('settings-hotkey-add-well');
        const hkMarker = document.getElementById('settings-hotkey-add-marker');
        const hkDuct = document.getElementById('settings-hotkey-add-duct-cable');
        const hkGround = document.getElementById('settings-hotkey-add-ground-cable');
        const hkAerial = document.getElementById('settings-hotkey-add-aerial-cable');
        const inputStart = document.getElementById('settings-input-well-number-start');
        const poleStart = document.getElementById('settings-pole-well-number-start');

        if (z) z.value = (this.settings.map_default_zoom ?? MapManager.defaultZoom ?? 14);
        if (lat) lat.value = (this.settings.map_default_lat ?? (MapManager.defaultCenter?.[0] ?? 66.10231));
        if (lng) lng.value = (this.settings.map_default_lng ?? (MapManager.defaultCenter?.[1] ?? 76.68617));
        if (len) {
            len.value = (this.settings.cable_in_well_length_m ?? 2);
            // Глобальная настройка: менять может только root
            len.disabled = !this.isRoot();
            if (!this.isRoot()) len.style.background = 'var(--bg-tertiary)';
        }
        if (inputStart) {
            inputStart.value = (this.settings.input_well_number_start ?? 1);
            // Глобальная настройка: менять может только root
            inputStart.disabled = !this.isRoot();
            if (!this.isRoot()) inputStart.style.background = 'var(--bg-tertiary)';
        }
        if (poleStart) {
            poleStart.value = (this.settings.well_pole_number_start ?? 100000);
            // Глобальная настройка: менять может только root
            poleStart.disabled = !this.isRoot();
            if (!this.isRoot()) poleStart.style.background = 'var(--bg-tertiary)';
        }
        if (wDir) wDir.value = (this.settings.line_weight_direction ?? 3);
        if (wCable) wCable.value = (this.settings.line_weight_cable ?? 2);
        if (iconSize) iconSize.value = (this.settings.icon_size_well_marker ?? 24);
        if (fsWell) fsWell.value = (this.settings.font_size_well_number_label ?? 12);
        if (fsDirLen) fsDirLen.value = (this.settings.font_size_direction_length_label ?? 12);
        if (selColor) selColor.value = (this.settings.selected_object_highlight_color ?? '#ffff00');
        if (magnetPx) magnetPx.value = (this.settings.magnet_pixels ?? 0);
        if (geo) geo.value = (this.settings.url_geoproj ?? '');
        if (cad) cad.value = (this.settings.url_cadastre ?? '');
        if (wmtsUrlTmpl) wmtsUrlTmpl.value = (this.settings.wmts_url_template ?? '');
        if (wmtsStyle) wmtsStyle.value = (this.settings.wmts_style ?? 'default');
        if (wmtsTms) wmtsTms.value = (this.settings.wmts_tilematrixset ?? 'GoogleMapsCompatible');
        if (wmtsTm) wmtsTm.value = (this.settings.wmts_tilematrix ?? '{z}');
        if (wmtsTr) wmtsTr.value = (this.settings.wmts_tilerow ?? '{y}');
        if (wmtsTc) wmtsTc.value = (this.settings.wmts_tilecol ?? '{x}');
        if (hkDir) hkDir.value = (this.settings.hotkey_add_direction ?? '');
        if (hkWell) hkWell.value = (this.settings.hotkey_add_well ?? '');
        if (hkMarker) hkMarker.value = (this.settings.hotkey_add_marker ?? '');
        if (hkDuct) hkDuct.value = (this.settings.hotkey_add_duct_cable ?? '');
        if (hkGround) hkGround.value = (this.settings.hotkey_add_ground_cable ?? '');
        if (hkAerial) hkAerial.value = (this.settings.hotkey_add_aerial_cable ?? '');
        if (inbuildingStatus) inbuildingStatus.value = (this.settings.direction_inbuilding_status_code ?? 'inbuilding');

        // Заполняем список "Код — точка ввода" (object_kinds.code) только для вида объекта "Колодец"
        // Доступно только для admin/root (секция "Настройка данных ГИС")
        if ((entryKind || poleKind) && isAdminLike) {
            try {
                const [typesResp, kindsResp] = await Promise.all([
                    API.references.all('object_types'),
                    API.references.all('object_kinds'),
                ]);
                const types = typesResp?.data || [];
                const kinds = kindsResp?.data || [];
                const wellType = (types || []).find(t => (t.code || '') === 'well');
                const wellTypeId = wellType?.id;
                const filtered = wellTypeId
                    ? (kinds || []).filter(k => String(k.object_type_id) === String(wellTypeId))
                    : [];
                filtered.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));

                const options = '<option value="">Не задано</option>' +
                    filtered.map(k => `<option value="${this.escapeHtml(k.code || '')}">${this.escapeHtml(k.code || '')} — ${this.escapeHtml(k.name || '')}</option>`).join('');
                if (entryKind) {
                    entryKind.innerHTML = options;
                    entryKind.value = (this.settings.well_entry_point_kind_code ?? '');
                }
                if (poleKind) {
                    poleKind.innerHTML = options;
                    poleKind.value = (this.settings.well_pole_kind_code ?? 'pole');
                }
            } catch (_) {
                // ignore
            }
        }

        // Заполняем список статусов для "Направление по зданию" (object_status.code)
        if (inbuildingStatus) {
            if (isAdminLike) {
                try {
                    const resp = await API.references.all('object_status');
                    const rows = resp?.data || resp || [];
                    const list = Array.isArray(rows) ? rows : [];
                    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
                    inbuildingStatus.innerHTML = '<option value="">Не задано</option>' +
                        list.map(s => {
                            const code = (s.code || '').toString();
                            const name = (s.name || '').toString();
                            return `<option value="${this.escapeHtml(code)}">${this.escapeHtml(name)}${code ? ` (${this.escapeHtml(code)})` : ''}</option>`;
                        }).join('');
                    inbuildingStatus.value = (this.settings.direction_inbuilding_status_code ?? 'inbuilding');
                    inbuildingStatus.disabled = !(this.isAdmin() || this.isRoot());
                    if (inbuildingStatus.disabled) inbuildingStatus.style.background = 'var(--bg-tertiary)';
                } catch (_) {
                    // ignore
                }
            } else {
                inbuildingStatus.disabled = true;
                try { inbuildingStatus.style.background = 'var(--bg-tertiary)'; } catch (_) {}
            }
        }

        // Админ: секция бэкапов СУБД
        if (this.isAdmin()) {
            this.initDbBackupSettingsPanel().catch(() => {});
        }
    },

    async initDbBackupSettingsPanel() {
        const host = document.getElementById('db-backup-settings');
        if (!host) return;

        // bind buttons once
        if (!this._boundDbBackupSettings) {
            this._boundDbBackupSettings = true;
            document.getElementById('btn-db-backup-refresh')?.addEventListener('click', () => this.refreshDbBackups());
            document.getElementById('btn-db-backup-create-now')?.addEventListener('click', () => this.createDbBackupNow());
            document.getElementById('btn-db-backup-save-schedule')?.addEventListener('click', () => this.saveDbBackupSchedule());
            document.getElementById('btn-db-backup-run-tick')?.addEventListener('click', () => this.runDbBackupTick());
            document.getElementById('btn-db-backup-cron-copy')?.addEventListener('click', () => this.copyDbBackupCronLine());
            document.getElementById('btn-db-backup-cron-install')?.addEventListener('click', () => this.installDbBackupCron());
            document.getElementById('btn-db-backup-cron-remove')?.addEventListener('click', () => this.removeDbBackupCron());
        }

        await this.loadDbBackupConfig();
        await this.loadDbBackupCronInfo();
        await this.refreshDbBackups();
    },

    async loadDbBackupCronInfo() {
        const ta = document.getElementById('db-backup-cron-line');
        const st = document.getElementById('db-backup-cron-status');
        if (st) st.textContent = '';
        try {
            const resp = await API.dbBackups.cronInfo();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const data = resp?.data || resp || {};
            if (ta) ta.value = String(data.line || '');
            if (st) st.textContent = data.installed ? 'Установлено' : 'Не установлено';
        } catch (e) {
            if (st) st.textContent = 'Недоступно';
            if (ta && !ta.value) ta.value = '';
        }
    },

    async copyDbBackupCronLine() {
        const ta = document.getElementById('db-backup-cron-line');
        const text = (ta?.value || '').toString().trim();
        if (!text) {
            this.notify('Команда crontab не сформирована', 'warning');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            this.notify('Команда скопирована', 'success');
        } catch (_) {
            this.notify('Не удалось скопировать команду', 'error');
        }
    },

    async installDbBackupCron() {
        try {
            const resp = await API.dbBackups.cronInstall();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Правило crontab установлено', 'success');
            await this.loadDbBackupCronInfo();
        } catch (e) {
            this.notify(e?.message || 'Не удалось установить crontab', 'error');
        }
    },

    async removeDbBackupCron() {
        try {
            const resp = await API.dbBackups.cronRemove();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Правило crontab удалено', 'success');
            await this.loadDbBackupCronInfo();
        } catch (e) {
            this.notify(e?.message || 'Не удалось удалить crontab', 'error');
        }
    },

    async loadDbBackupConfig() {
        try {
            const resp = await API.dbBackups.config();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const data = resp?.data || resp || {};

            const enabled = document.getElementById('db-backup-schedule-enabled');
            const interval = document.getElementById('db-backup-interval-hours');
            const keep = document.getElementById('db-backup-keep-count');
            const last = document.getElementById('db-backup-last-run');

            if (enabled) enabled.checked = !!data.schedule_enabled;
            if (interval) interval.value = String(data.interval_hours ?? 24);
            if (keep) keep.value = (data.keep_count === null || data.keep_count === undefined) ? '' : String(data.keep_count);
            if (last) {
                const v = data.last_run_at ? new Date(data.last_run_at).toLocaleString('ru-RU') : '-';
                last.value = v;
            }
        } catch (e) {
            // не спамим ошибками в настройках
            console.error('DB backup config load error:', e);
        }
    },

    async saveDbBackupSchedule() {
        try {
            const enabled = !!document.getElementById('db-backup-schedule-enabled')?.checked;
            const intervalHours = parseInt(document.getElementById('db-backup-interval-hours')?.value || '24', 10);
            const keepRaw = (document.getElementById('db-backup-keep-count')?.value || '').toString().trim();
            const keepCount = keepRaw === '' ? null : parseInt(keepRaw, 10);

            const payload = { schedule_enabled: enabled, interval_hours: intervalHours, keep_count: keepCount };
            const resp = await API.dbBackups.updateConfig(payload);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Настройки бэкапа сохранены', 'success');
            await this.loadDbBackupConfig();
            // строка/статус crontab зависит от interval_hours и может обновляться автоматически на сервере
            await this.loadDbBackupCronInfo();
        } catch (e) {
            this.notify(e?.message || 'Ошибка сохранения', 'error');
        }
    },

    async refreshDbBackups() {
        const listEl = document.getElementById('db-backups-list');
        if (listEl) listEl.innerHTML = '<div class="text-muted">Загрузка...</div>';
        try {
            const resp = await API.dbBackups.list();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const list = resp?.data || resp || [];
            if (!Array.isArray(list) || list.length === 0) {
                if (listEl) listEl.innerHTML = '<div class="text-muted">Бэкапы отсутствуют</div>';
                return;
            }

            const fmtSize = (b) => {
                const n = Number(b || 0);
                if (!Number.isFinite(n) || n <= 0) return '-';
                const units = ['B', 'KB', 'MB', 'GB'];
                let v = n;
                let i = 0;
                while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
                return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
            };

            const rows = list.map(x => {
                const id = String(x.id || '');
                const dt = x.created_at ? new Date(x.created_at).toLocaleString('ru-RU') : '-';
                const sz = fmtSize(x.size_bytes);
                return `
                    <div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom: 1px solid var(--border-color);">
                        <div style="flex:1; min-width:0;">
                            <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(id)}</div>
                            <div class="text-muted" style="font-size:12px;">${this.escapeHtml(dt)} • ${this.escapeHtml(sz)}</div>
                        </div>
                        <button type="button" class="btn btn-sm btn-danger" onclick='App.restoreDbBackup(${JSON.stringify(id)})' title="Восстановить БД из этого бэкапа">
                            <i class="fas fa-rotate-left"></i> Восстановить
                        </button>
                    </div>
                `;
            }).join('');
            if (listEl) listEl.innerHTML = rows;
        } catch (e) {
            if (listEl) listEl.innerHTML = `<div class="text-muted">Ошибка загрузки списка: ${this.escapeHtml(e?.message || 'Ошибка')}</div>`;
        }
    },

    async createDbBackupNow() {
        try {
            this.notify('Создание бэкапа...', 'info');
            const resp = await API.dbBackups.create();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Бэкап создан', 'success');
            await this.loadDbBackupConfig();
            await this.refreshDbBackups();
        } catch (e) {
            this.notify(e?.message || 'Ошибка создания бэкапа', 'error');
        }
    },

    async runDbBackupTick() {
        try {
            const resp = await API.dbBackups.tick();
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            // create() в tick() может вернуть "Бэкап создан" как success message,
            // поэтому просто обновим.
            await this.loadDbBackupConfig();
            await this.refreshDbBackups();
            this.notify('Проверка расписания выполнена', 'info');
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async restoreDbBackup(id) {
        const bid = String(id || '');
        if (!bid) return;
        const ok = confirm(
            `Восстановить базу данных из бэкапа?\n\n` +
            `Файл: ${bid}\n\n` +
            `ВНИМАНИЕ: операция перезапишет текущие данные. Во время восстановления система может работать нестабильно.`
        );
        if (!ok) return;

        try {
            this.notify('Восстановление БД...', 'warning');
            const resp = await API.dbBackups.restore(bid);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('База данных восстановлена', 'success');
            await this.refreshDbBackups();
        } catch (e) {
            this.notify(e?.message || 'Ошибка восстановления', 'error');
        }
    },

    async saveSettings() {
        const z = document.getElementById('settings-map-zoom')?.value;
        const lat = document.getElementById('settings-map-lat')?.value;
        const lng = document.getElementById('settings-map-lng')?.value;
        const len = document.getElementById('settings-cable-well-len')?.value;
        const wDir = document.getElementById('settings-line-weight-direction')?.value;
        const wCable = document.getElementById('settings-line-weight-cable')?.value;
        const iconSize = document.getElementById('settings-icon-size-well-marker')?.value;
        const fsWell = document.getElementById('settings-font-size-well-number')?.value;
        const fsDirLen = document.getElementById('settings-font-size-direction-length')?.value;
        const selColor = document.getElementById('settings-selected-object-highlight-color')?.value;
        const magnetPx = document.getElementById('settings-magnet-pixels')?.value;
        const geo = document.getElementById('settings-url-geoproj')?.value;
        const cad = document.getElementById('settings-url-cadastre')?.value;
        const wmtsUrlTmpl = document.getElementById('settings-wmts-url-template')?.value;
        const wmtsStyle = document.getElementById('settings-wmts-style')?.value;
        const wmtsTms = document.getElementById('settings-wmts-tilematrixset')?.value;
        const wmtsTm = document.getElementById('settings-wmts-tilematrix')?.value;
        const wmtsTr = document.getElementById('settings-wmts-tilerow')?.value;
        const wmtsTc = document.getElementById('settings-wmts-tilecol')?.value;
        const entryKind = document.getElementById('settings-well-entry-kind-code')?.value;
        const poleKind = document.getElementById('settings-well-pole-kind-code')?.value;
        const inbuildingStatus = document.getElementById('settings-direction-inbuilding-status-code')?.value;
        const hkDir = document.getElementById('settings-hotkey-add-direction')?.value;
        const hkWell = document.getElementById('settings-hotkey-add-well')?.value;
        const hkMarker = document.getElementById('settings-hotkey-add-marker')?.value;
        const hkDuct = document.getElementById('settings-hotkey-add-duct-cable')?.value;
        const hkGround = document.getElementById('settings-hotkey-add-ground-cable')?.value;
        const hkAerial = document.getElementById('settings-hotkey-add-aerial-cable')?.value;
        const inputStart = document.getElementById('settings-input-well-number-start')?.value;
        const poleStart = document.getElementById('settings-pole-well-number-start')?.value;

        const normalizeHotkey = (v) => {
            const s = (v ?? '').toString().trim();
            if (!s) return '';
            return s.length ? s[0] : '';
        };
        const validateHotkey = (label, v) => {
            const s = normalizeHotkey(v);
            if (!s) return '';
            if (!/^[a-z0-9]$/i.test(s)) {
                this.notify(`Hotkey для "${label}" должен быть одной латинской буквой или цифрой`, 'error');
                throw new Error('invalid_hotkey');
            }
            return s.toLowerCase();
        };

        const payload = {
            map_default_zoom: z,
            map_default_lat: lat,
            map_default_lng: lng,
            // глобальная настройка — только root (остальным не отправляем)
            ...(this.isRoot() ? { cable_in_well_length_m: len, input_well_number_start: inputStart, well_pole_number_start: poleStart } : {}),
            line_weight_direction: wDir,
            line_weight_cable: wCable,
            icon_size_well_marker: iconSize,
            font_size_well_number_label: fsWell,
            font_size_direction_length_label: fsDirLen,
            selected_object_highlight_color: (selColor ?? '').toString().trim(),
            magnet_pixels: magnetPx,
            url_geoproj: geo,
            url_cadastre: cad,
            wmts_url_template: wmtsUrlTmpl,
            wmts_style: wmtsStyle,
            wmts_tilematrixset: wmtsTms,
            wmts_tilematrix: wmtsTm,
            wmts_tilerow: wmtsTr,
            wmts_tilecol: wmtsTc,
            ...(this.isAdmin() || this.isRoot() ? {
                well_entry_point_kind_code: (entryKind ?? '').toString(),
                well_pole_kind_code: (poleKind ?? '').toString(),
                direction_inbuilding_status_code: (inbuildingStatus ?? '').toString().trim(),
            } : {}),
        };
        try {
            payload.hotkey_add_direction = validateHotkey('Добавить направление', hkDir);
            payload.hotkey_add_well = validateHotkey('Добавить колодец', hkWell);
            payload.hotkey_add_marker = validateHotkey('Добавить столбик', hkMarker);
            payload.hotkey_add_duct_cable = validateHotkey('Добавить кабель в канализации', hkDuct);
            payload.hotkey_add_ground_cable = validateHotkey('Добавить кабель в грунте', hkGround);
            payload.hotkey_add_aerial_cable = validateHotkey('Добавить воздушный кабель', hkAerial);
        } catch (e) {
            if (e?.message === 'invalid_hotkey') return;
            // continue - unexpected
        }

        try {
            const resp = await API.settings.update(payload);
            if (resp?.success === false) {
                this.notify(resp.message || 'Ошибка сохранения', 'error');
                return;
            }
            this.notify('Настройки сохранены', 'success');

            // Обновляем локально и применяем (центр/зум — для следующей инициализации карты)
            await this.loadSettings().catch(() => {});
            // Пересоздаём WMTS слой из настроек (если включён/выключен не меняем)
            try {
                if (MapManager?.map && MapManager?.wmtsSatelliteLayer) {
                    const enabled = !!MapManager.wmtsSatelliteEnabled;
                    try { MapManager.map.removeLayer(MapManager.wmtsSatelliteLayer); } catch (_) {}
                    MapManager.wmtsSatelliteLayer = null;
                    // пересоздаём через init-логику, но без полного init()
                    const tmpl = MapManager.buildWmtsTileUrlTemplateFromSettings?.();
                    if (tmpl) {
                        MapManager.wmtsSatelliteLayer = L.tileLayer(tmpl, { maxZoom: 22, attribution: '&copy; ЯНАО' });
                        if (enabled) {
                            MapManager.setWmtsSatelliteEnabled(true);
                        }
                    }
                }
            } catch (_) {}
            // Применяем визуальные настройки сразу
            try { await MapManager.loadAllLayers?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка сохранения', 'error');
        }
    },

    /**
     * Отрисовка таблицы справочника
     */
    renderReferenceTable(data) {
        if (!data || data.length === 0) {
            document.getElementById('ref-table-body').innerHTML = '<tr><td colspan="100">Нет данных</td></tr>';
            return;
        }

        const columnsByType = {
            object_types: ['code', 'name', 'description', 'reference_table', 'number_code', 'icon', 'color'],
            object_kinds: ['code', 'name', 'object_type_id', 'description', 'is_default'],
            object_status: ['code', 'name', 'color', 'description', 'sort_order', 'is_default'],
            owners: ['code', 'name', 'short_name', 'color', 'inn', 'address', 'contact_person', 'contact_phone', 'contact_email', 'notes', 'is_default'],
            contracts: ['number', 'name', 'owner_id', 'landlord_id', 'start_date', 'end_date', 'status', 'amount', 'notes', 'is_default'],
            cable_types: ['code', 'name', 'description', 'is_default'],
            cable_catalog: ['cable_type_id', 'fiber_count', 'marking', 'description', 'is_default'],
        };

        const labelByType = {
            object_types: { code: 'Код', name: 'Название', description: 'Описание', reference_table: 'Справочная таблица', number_code: 'Код номера', icon: 'Иконка', color: 'Цвет' },
            object_kinds: { code: 'Код', name: 'Название', object_type_id: 'Вид объекта', description: 'Описание', is_default: 'По умолчанию' },
            object_status: { code: 'Код', name: 'Название', color: 'Цвет', description: 'Описание', sort_order: 'Порядок', is_default: 'По умолчанию' },
            owners: {
                code: 'Код', name: 'Название', short_name: 'Краткое название', inn: 'ИНН',
                address: 'Адрес', contact_person: 'Контактное лицо', contact_phone: 'Телефон', contact_email: 'Email',
                color: 'Цвет', notes: 'Примечания', is_default: 'По умолчанию'
            },
            contracts: {
                number: 'Номер', name: 'Название', owner_id: 'Арендатор', landlord_id: 'Арендодатель',
                start_date: 'Дата начала', end_date: 'Дата окончания', status: 'Статус', amount: 'Сумма',
                notes: 'Примечания', is_default: 'По умолчанию'
            },
            cable_types: { code: 'Код', name: 'Название', description: 'Описание', is_default: 'По умолчанию' },
            cable_catalog: { cable_type_id: 'Тип кабеля', fiber_count: 'Волокон', marking: 'Маркировка', description: 'Описание', is_default: 'По умолчанию' },
        };

        const type = this.currentReference || '';
        const rawColumns = Object.keys(data[0]).filter(k => !['id', 'created_at', 'updated_at', 'permissions'].includes(k));
        const columns = (columnsByType[type] || rawColumns).filter(col => rawColumns.includes(col));
        const canManage = this.canManageReferenceType(type);

        const formatCell = (col, value, row) => {
            if (col === 'is_default') return value ? 'Да' : '-';
            if (value === null || value === undefined || value === '') return '-';
            if (col === 'reference_table') {
                const v = String(value || '');
                const map = {
                    object_kinds: 'Типы объектов',
                    cable_types: 'Типы кабелей',
                    cable_catalog: 'Каталог кабелей',
                };
                return map[v] || v;
            }
            if (col === 'color') {
                const c = String(value);
                return `<span style="display:inline-flex; align-items:center; gap:8px;"><span style="width:14px;height:14px;border-radius:4px;background:${c};border:1px solid rgba(0,0,0,0.25);"></span>${this.escapeHtml(c)}</span>`;
            }
            // FK -> название
            if (type === 'object_kinds' && col === 'object_type_id') {
                return row?.object_type_name || String(value);
            }
            if (type === 'contracts' && col === 'owner_id') {
                return row?.owner_name || String(value);
            }
            if (type === 'contracts' && col === 'landlord_id') {
                return row?.landlord_name || String(value);
            }
            return String(value);
        };
        
        document.getElementById('ref-table-header').innerHTML = 
            columns.map(col => `<th>${(labelByType[type]?.[col] || col)}</th>`).join('') + (canManage ? '<th>Действия</th>' : '');
        
        document.getElementById('ref-table-body').innerHTML = data.map(row => `
            <tr>
                ${columns.map(col => `<td>${formatCell(col, row[col], row)}</td>`).join('')}
                ${canManage ? `
                    <td>
                        <button class="btn btn-sm btn-primary" onclick="App.editReference(${row.id})">
                            <i class="fas fa-edit"></i>
                        </button>
                        ${this.currentReference === 'object_types' ? '' : `
                            <button class="btn btn-sm btn-danger" onclick="App.deleteReference(${row.id})">
                                <i class="fas fa-trash"></i>
                            </button>
                        `}
                    </td>
                ` : ''}
            </tr>
        `).join('');
    },

    /**
     * Загрузка пользователей
     */
    async loadUsers() {
        try {
            const response = await API.users.list();
            if (response.success) {
                this.renderUsersTable(response.data);
                this.renderAuditLogPanel(response.data);
            }
        } catch (error) {
            this.notify('Ошибка загрузки пользователей', 'error');
        }
    },

    /**
     * Отрисовка таблицы пользователей
     */
    renderUsersTable(users) {
        document.getElementById('users-table-body').innerHTML = users.map(user => `
            <tr>
                <td>${user.id}</td>
                <td>${user.login}</td>
                <td>${user.full_name || '-'}</td>
                <td>${user.email || '-'}</td>
                <td>${user.role_name}</td>
                <td>${user.owner_name || '-'}</td>
                <td><span class="status-badge ${user.is_active ? 'active' : 'inactive'}">${user.is_active ? 'Да' : 'Нет'}</span></td>
                <td>${this.formatDate(user.last_login)}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.showUserAuditLog(${user.id})" title="Показать действия пользователя">
                        <i class="fas fa-history"></i>
                    </button>
                    <button class="btn btn-sm btn-primary" onclick="App.editUser(${user.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    ${user.login === 'root' ? '' : `
                        <button class="btn btn-sm btn-danger" onclick="App.deleteUser(${user.id})" title="Удалить">
                            <i class="fas fa-trash"></i>
                        </button>
                    `}
                </td>
            </tr>
        `).join('');
    },

    renderAuditLogPanel(users) {
        const el = document.getElementById('audit-log');
        if (!el) return;

        const list = Array.isArray(users) ? users : [];
        const options = [
            `<option value="">Все пользователи</option>`,
            ...list.map(u => `<option value="${u.id}">${this.escapeHtml(u.login)}${u.full_name ? ' — ' + this.escapeHtml(u.full_name) : ''}</option>`)
        ].join('');

        el.innerHTML = `
            <div class="filters-row" style="margin: 10px 0;">
                <select id="audit-user-select">${options}</select>
                <button class="btn btn-primary btn-sm" id="btn-audit-refresh">
                    <i class="fas fa-rotate"></i> Показать
                </button>
                <span class="text-muted" id="audit-log-hint" style="margin-left:auto;"></span>
            </div>
            <div id="audit-log-table" style="overflow:auto; max-height: 55vh; border: 1px solid var(--border-color); border-radius: 10px;"></div>
        `;

        if (!this._boundAuditLogPanel) {
            this._boundAuditLogPanel = true;
            document.addEventListener('click', (e) => {
                if (e?.target?.id === 'btn-audit-refresh' || e?.target?.closest?.('#btn-audit-refresh')) {
                    this.loadAuditLogFromUi();
                }
            });
            document.addEventListener('change', (e) => {
                if (e?.target?.id === 'audit-user-select') {
                    this.loadAuditLogFromUi();
                }
            });
        }

        // По умолчанию показываем последние действия (все пользователи)
        this.loadAuditLogFromUi();
    },

    showUserAuditLog(userId) {
        const sel = document.getElementById('audit-user-select');
        if (sel) sel.value = String(userId || '');
        // переключаемся к журналу
        try { document.getElementById('audit-log')?.scrollIntoView({ block: 'start' }); } catch (_) {}
        this.loadAuditLogFromUi();
    },

    async loadAuditLogFromUi() {
        const uid = (document.getElementById('audit-user-select')?.value || '').toString().trim();
        const userId = uid ? parseInt(uid, 10) : 0;
        return this.loadAuditLog(userId);
    },

    async loadAuditLog(userId = 0) {
        const tableEl = document.getElementById('audit-log-table');
        const hintEl = document.getElementById('audit-log-hint');
        if (!tableEl) return;
        tableEl.innerHTML = `<div class="text-muted" style="padding:12px;">Загрузка...</div>`;
        if (hintEl) hintEl.textContent = 'Показываются последние 1000 действий';

        try {
            const params = { limit: 1000 };
            if (userId) params.user_id = userId;
            const resp = await API.auditLog.list(params);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const rows = resp?.data || resp || [];
            if (!Array.isArray(rows) || rows.length === 0) {
                tableEl.innerHTML = `<div class="text-muted" style="padding:12px;">Нет данных</div>`;
                return;
            }

            const actionName = (a) => {
                const x = (a || '').toString();
                const map = {
                    login: 'Логин',
                    logout: 'Выход',
                    create: 'Создание',
                    update: 'Редактирование',
                    delete: 'Удаление',
                    export: 'Выгрузка',
                    import: 'Загрузка',
                    report: 'Отчёт',
                    report_export: 'Выгрузка отчёта',
                    backup_create: 'Бэкап БД',
                    backup_restore: 'Восстановление БД',
                };
                return map[x] || x;
            };

            const fmtDt = (v) => {
                try { return v ? new Date(v).toLocaleString('ru-RU') : '-'; } catch (_) { return '-'; }
            };

            tableEl.innerHTML = `
                <table style="width:100%; border-collapse: collapse;">
                    <thead>
                        <tr>
                            <th style="position: sticky; top: 0;">Дата/время</th>
                            <th style="position: sticky; top: 0;">Пользователь</th>
                            <th style="position: sticky; top: 0;">Действие</th>
                            <th style="position: sticky; top: 0;">Объект</th>
                            <th style="position: sticky; top: 0;">ID</th>
                            <th style="position: sticky; top: 0;">IP</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => `
                            <tr>
                                <td>${this.escapeHtml(fmtDt(r.created_at))}</td>
                                <td>${this.escapeHtml(r.user_login || '-')}${r.user_full_name ? `<div class="text-muted" style="font-size:12px;">${this.escapeHtml(r.user_full_name)}</div>` : ''}</td>
                                <td>${this.escapeHtml(actionName(r.action))}</td>
                                <td>${this.escapeHtml(r.table_name || '-')}</td>
                                <td>${this.escapeHtml(r.record_id ?? '-')}</td>
                                <td>${this.escapeHtml(r.ip_address || '-')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        } catch (e) {
            tableEl.innerHTML = `<div class="text-muted" style="padding:12px;">Ошибка: ${this.escapeHtml(e?.message || 'Ошибка')}</div>`;
        }
    },

    async editUser(id) {
        try {
            const resp = await API.users.list();
            if (!resp?.success) {
                this.notify(resp?.message || 'Ошибка загрузки пользователей', 'error');
                return;
            }
            const users = resp.data || [];
            const user = users.find(u => String(u.id) === String(id));
            if (!user) {
                this.notify('Пользователь не найден', 'error');
                return;
            }

            const content = `
                <form id="user-edit-form">
                    <input type="hidden" name="id" value="${user.id}">
                    <div class="form-group">
                        <label>Логин (только чтение)</label>
                        <input type="text" value="${this.escapeHtml(user.login)}" readonly style="background: var(--bg-tertiary);">
                    </div>
                    <div class="form-group">
                        <label>Пароль (мин. 6, оставить пустым — не менять)</label>
                        <input type="password" name="password" minlength="6" autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <label>Полное имя</label>
                        <input type="text" name="full_name" value="${this.escapeHtml(user.full_name || '')}">
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" name="email" value="${this.escapeHtml(user.email || '')}">
                    </div>
                    <div class="form-group">
                        <label>Роль *</label>
                        <select name="role_id" required id="user-edit-role-select"></select>
                    </div>
                    <div class="form-group" id="user-edit-owner-group" style="display:none;">
                        <label>Собственник (только для роли "Только чтение")</label>
                        <select name="owner_id" id="user-edit-owner-select" disabled></select>
                        <p class="text-muted">На карте будут видны только кабели этого собственника.</p>
                    </div>
                    <div class="form-group">
                        <label>
                            <input type="checkbox" name="is_active" value="1" ${user.is_active ? 'checked' : ''}>
                            Активен
                        </label>
                    </div>
                </form>
            `;

            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                ${user.login === 'root' ? '' : `
                    <button class="btn btn-danger" onclick="App.deleteUser(${user.id})" style="margin-left:auto;">
                        <i class="fas fa-trash"></i> Удалить
                    </button>
                `}
                <button class="btn btn-primary" onclick="App.submitUserEdit(${user.id})">
                    <i class="fas fa-save"></i> Сохранить
                </button>
            `;

            this.showModal(`Пользователь: ${user.login}`, content, footer);
            await this.loadRolesSelect('user-edit-role-select', user.role_code);
            await this.loadOwnersSelect('user-edit-owner-select', user.owner_id ?? null);
            this.bindReadonlyOwnerToUserRoleSelect('user-edit-role-select', 'user-edit-owner-group', 'user-edit-owner-select');
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async submitUserEdit(id) {
        const form = document.getElementById('user-edit-form');
        if (!form) return;

        const fd = new FormData(form);
        const data = Object.fromEntries(fd.entries());

        // checkbox -> boolean
        data.is_active = !!form.querySelector('input[name="is_active"]')?.checked;

        // Пустой пароль не отправляем
        if (!data.password) delete data.password;

        // Приводим role_id к числу
        if (data.role_id !== undefined) data.role_id = parseInt(data.role_id, 10);
        if (!data.owner_id) {
            delete data.owner_id;
        } else {
            data.owner_id = parseInt(data.owner_id, 10);
        }

        try {
            const resp = await API.users.update(id, data);
            if (resp?.success) {
                this.hideModal();
                this.notify('Пользователь обновлён', 'success');
                this.loadUsers();
            } else {
                this.notify(resp?.message || 'Ошибка', 'error');
            }
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    async deleteUser(id) {
        if (!confirm('Удалить пользователя? (будет деактивирован)')) return;
        try {
            const resp = await API.users.delete(id);
            if (resp?.success) {
                this.notify('Пользователь деактивирован', 'success');
                this.hideModal();
                this.loadUsers();
            } else {
                this.notify(resp?.message || 'Ошибка', 'error');
            }
        } catch (e) {
            this.notify(e?.message || 'Ошибка', 'error');
        }
    },

    /**
     * Модальное окно
     */
    showModal(title, content, footer = '', opts = null) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = content;
        document.getElementById('modal-footer').innerHTML = footer;
        const modal = document.getElementById('modal');
        // сброс вариантов позиционирования/режимов
        modal.classList.remove('modal-nonblocking', 'modal-bottom-left', 'modal-bottom-right', 'modal-top-right', 'modal-fit-content');
        // применяем опции (если есть)
        try {
            const o = opts || {};
            if (o.nonBlocking) modal.classList.add('modal-nonblocking');
            if (o.position === 'bottom-left') modal.classList.add('modal-bottom-left');
            if (o.position === 'bottom-right') modal.classList.add('modal-bottom-right');
            if (o.position === 'top-right') modal.classList.add('modal-top-right');
            if (o.fitContent) modal.classList.add('modal-fit-content');
        } catch (_) {}
        modal.classList.remove('hidden');

        // Дата/время по умолчанию для пустых полей
        const now = new Date();
        const pad2 = (n) => String(n).padStart(2, '0');
        const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        const nowLocal = `${today}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        modal.querySelectorAll('input[type="date"]').forEach((el) => {
            if (!el.value) el.value = today;
        });
        modal.querySelectorAll('input[type="datetime-local"]').forEach((el) => {
            if (!el.value) el.value = nowLocal;
        });
    },

    hideModal() {
        const modal = document.getElementById('modal');
        modal.classList.add('hidden');
        // сбрасываем модификаторы, чтобы следующий показ был "обычным"
        modal.classList.remove('modal-nonblocking', 'modal-bottom-left', 'modal-bottom-right', 'modal-top-right', 'modal-fit-content');
    },

    /**
     * Показ уведомления
     */
    notify(message, type = 'info') {
        const container = document.getElementById('notifications');
        const id = Date.now();
        
        const icons = {
            success: 'check-circle',
            error: 'exclamation-circle',
            warning: 'exclamation-triangle',
            info: 'info-circle',
        };

        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.id = `notification-${id}`;
        notification.innerHTML = `
            <i class="fas fa-${icons[type] || icons.info}"></i>
            <span>${message}</span>
        `;

        container.appendChild(notification);

        setTimeout(() => {
            notification.remove();
        }, 5000);
    },

    // ========================
    // Карта: экспорт в PDF
    // ========================

    async saveMapPdf() {
        const mapEl = document.getElementById('map');
        if (!mapEl) {
            this.notify('Карта не найдена', 'error');
            return;
        }
        const h2c = (typeof window !== 'undefined') ? window.html2canvas : null;
        const jsPdfCtor = (typeof window !== 'undefined') ? (window.jspdf?.jsPDF || window.jspdf?.default?.jsPDF) : null;
        if (typeof h2c !== 'function' || typeof jsPdfCtor !== 'function') {
            this.notify('Модуль экспорта PDF не загружен', 'error');
            return;
        }

        const userName = (this.user?.full_name || this.user?.login || '').toString().trim() || 'Пользователь';
        const logoUrl = 'assets/favicon.svg';

        const pad2 = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const ts = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
        const safeUser = (this.user?.login || userName).toString().trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 30) || 'user';
        const filename = `map_${ts}_${safeUser}.pdf`;

        const svgToPngDataUrl = async (url, size = 56) => {
            try {
                const resp = await fetch(url, { cache: 'force-cache' });
                if (!resp.ok) throw new Error('logo_fetch_failed');
                const svgText = await resp.text();
                const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
                const img = new Image();
                img.decoding = 'async';
                img.loading = 'eager';
                img.src = svgDataUrl;
                await new Promise((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject(new Error('logo_load_failed'));
                });
                const c = document.createElement('canvas');
                c.width = size;
                c.height = size;
                const ctx = c.getContext('2d');
                ctx.clearRect(0, 0, size, size);
                ctx.drawImage(img, 0, 0, size, size);
                return c.toDataURL('image/png');
            } catch (_) {
                return null;
            }
        };

        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const raf = () => new Promise(r => requestAnimationFrame(() => r()));

        const waitForLeafletIdle = async (timeoutMs = 2200) => {
            const map = MapManager?.map || null;
            if (!map || typeof map.once !== 'function') {
                await wait(250);
                return;
            }

            // stop any running animations (pan/zoom inertia)
            try { map.stop?.(); } catch (_) {}
            // force stable state (remove zoom-animation transforms)
            try {
                const c = map.getCenter?.();
                const z = map.getZoom?.();
                if (c && z !== undefined && z !== null) {
                    map.setView(c, z, { animate: false });
                }
            } catch (_) {}

            const baseLayer = MapManager?.wmtsSatelliteEnabled ? MapManager?.wmtsSatelliteLayer : MapManager?.osmBaseLayer;
            const shouldWaitTiles = !!(baseLayer && map.hasLayer?.(baseLayer));

            const waitMoveZoom = new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    try { map.off?.('moveend', finish); } catch (_) {}
                    try { map.off?.('zoomend', finish); } catch (_) {}
                    resolve();
                };
                try { map.once('moveend', finish); } catch (_) { /* ignore */ }
                try { map.once('zoomend', finish); } catch (_) { /* ignore */ }
                // if nothing happens, we still resolve by timeout below
            });

            const waitTiles = new Promise((resolve) => {
                if (!shouldWaitTiles) return resolve();
                // Leaflet GridLayer sets _loading while tiles pending
                const isLoading = !!baseLayer?._loading;
                if (!isLoading) return resolve();
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    try { baseLayer.off?.('load', finish); } catch (_) {}
                    try { baseLayer.off?.('tileerror', finish); } catch (_) {}
                    resolve();
                };
                try { baseLayer.once('load', finish); } catch (_) { resolve(); }
                try { baseLayer.once('tileerror', finish); } catch (_) {}
            });

            const timeout = wait(timeoutMs);

            // kick a redraw
            try { map.invalidateSize?.({ pan: false, animate: false }); } catch (_) {}

            // allow layout to settle
            await raf();
            await raf();
            await Promise.race([Promise.all([waitMoveZoom, waitTiles]), timeout]);
            await raf();
        };

        const captureMapPng = async () => {
            // даём Leaflet шанс дорисовать тайлы/векторы и остановить анимации
            await waitForLeafletIdle(2400);

            const rect = mapEl.getBoundingClientRect();
            const w = Math.max(1, Math.round(rect.width));
            const h = Math.max(1, Math.round(rect.height));
            const x = Math.max(0, Math.round(rect.left + (window.scrollX || window.pageXOffset || 0)));
            const y = Math.max(0, Math.round(rect.top + (window.scrollY || window.pageYOffset || 0)));

            const canvas = await h2c(mapEl, {
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#ffffff',
                scale: Math.min(2, window.devicePixelRatio || 1),
                logging: false,
                x,
                y,
                width: w,
                height: h,
                scrollX: (window.scrollX || window.pageXOffset || 0),
                scrollY: (window.scrollY || window.pageYOffset || 0),
                windowWidth: document.documentElement?.clientWidth || window.innerWidth,
                windowHeight: document.documentElement?.clientHeight || window.innerHeight,
            });
            // toDataURL может бросить SecurityError если подложка не даёт CORS
            const dataUrl = canvas.toDataURL('image/png');
            return { dataUrl, w: canvas.width, h: canvas.height };
        };

        const withExportUiHidden = async (fn) => {
            document.body.classList.add('igs-pdf-export');
            // если открыта модалка — убираем, чтобы она не перекрывала карту
            try { this.hideModal(); } catch (_) {}
            try { MapManager?.hideObjectInfo?.(); } catch (_) {}
            try { MapManager?.setAssumedCablesPanelVisible?.(false); } catch (_) {}
            try { MapManager?.setCablesListPanelVisible?.(false); } catch (_) {}
            try { MapManager?.setHighlightBarVisible?.(false); } catch (_) {}
            try { document.getElementById('object-info-panel')?.classList?.add('hidden'); } catch (_) {}

            try {
                // ensure map is not mid-zoom/pan and sizes are correct
                try { MapManager?.map?.stop?.(); } catch (_) {}
                try { MapManager?.map?.invalidateSize?.({ pan: false, animate: false }); } catch (_) {}
                return await fn();
            } finally {
                document.body.classList.remove('igs-pdf-export');
                try { MapManager?.setHighlightBarVisible?.(!!MapManager?.highlightLayer); } catch (_) {}
            }
        };

        const captureWithBasemapFallback = async () => {
            try {
                return await captureMapPng();
            } catch (e) {
                // Fallback: отключаем подложку (OSM/WMTS) и пробуем снова
                const wasWmts = !!MapManager?.wmtsSatelliteEnabled;
                try {
                    if (MapManager?.map && MapManager?.osmBaseLayer) MapManager.map.removeLayer(MapManager.osmBaseLayer);
                } catch (_) {}
                try {
                    if (MapManager?.map && MapManager?.wmtsSatelliteLayer) MapManager.map.removeLayer(MapManager.wmtsSatelliteLayer);
                } catch (_) {}
                try { mapEl.style.background = '#ffffff'; } catch (_) {}
                await wait(180);
                try {
                    const out = await captureMapPng();
                    this.notify('Подложка карты не может быть встроена в PDF (CORS). Экспорт выполнен без подложки.', 'warning');
                    return out;
                } finally {
                    // restore base map
                    try {
                        if (MapManager?.map) {
                            if (wasWmts) {
                                try { MapManager.setWmtsSatelliteEnabled?.(true); } catch (_) {}
                            } else {
                                try { MapManager.setWmtsSatelliteEnabled?.(false); } catch (_) {}
                            }
                        }
                    } catch (_) {}
                }
            }
        };

        this.notify('Формирование PDF…', 'info');

        const { dataUrl: mapPng, w: imgW, h: imgH } = await withExportUiHidden(captureWithBasemapFallback);
        const logoPng = await svgToPngDataUrl(logoUrl, 56);

        const orientation = (imgW >= imgH) ? 'landscape' : 'portrait';
        const pdf = new jsPdfCtor({ orientation, unit: 'pt', format: 'a4', compress: true });

        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();
        const margin = 28;
        const headerH = 64;

        // Шапку рисуем как картинку, чтобы кириллица отображалась корректно (jsPDF без встраивания шрифта ломает текст)
        const dt = now.toLocaleString('ru-RU');
        const buildHeaderPng = async () => {
            const scale = 2;
            const w = Math.max(1, Math.floor(pageW * scale));
            const h = Math.max(1, Math.floor(headerH * scale));
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#f5f5f5';
            ctx.fillRect(0, 0, w, h);

            const logoSize = Math.floor(32 * scale);
            const pad = Math.floor(margin * scale);
            const midY = Math.floor(h / 2);

            // logo (png)
            if (logoPng) {
                try {
                    const img = new Image();
                    img.decoding = 'async';
                    img.loading = 'eager';
                    img.src = logoPng;
                    await new Promise((resolve, reject) => {
                        img.onload = () => resolve();
                        img.onerror = () => reject(new Error('logo_png_load_failed'));
                    });
                    ctx.drawImage(img, pad, Math.floor((h - logoSize) / 2), logoSize, logoSize);
                } catch (_) {}
            }

            const textX = pad + (logoPng ? (logoSize + Math.floor(12 * scale)) : 0);
            ctx.fillStyle = '#141414';
            ctx.textBaseline = 'alphabetic';

            // title
            ctx.font = `700 ${Math.floor(14 * scale)}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
            ctx.fillText('ИГС — экспорт карты', textX, Math.floor(26 * scale));

            // user
            ctx.font = `${Math.floor(11 * scale)}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
            ctx.fillText(`Пользователь: ${userName}`, textX, Math.floor(46 * scale));

            // datetime right
            ctx.font = `${Math.floor(10 * scale)}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
            const dtW = ctx.measureText(dt).width;
            ctx.fillText(dt, Math.max(textX, w - pad - dtW), Math.floor(26 * scale));

            // subtle bottom line
            ctx.strokeStyle = 'rgba(0,0,0,0.08)';
            ctx.beginPath();
            ctx.moveTo(0, h - 1);
            ctx.lineTo(w, h - 1);
            ctx.stroke();

            return c.toDataURL('image/png');
        };

        try {
            const headerPng = await buildHeaderPng();
            pdf.addImage(headerPng, 'PNG', 0, 0, pageW, headerH, undefined, 'FAST');
        } catch (_) {
            // если шапка не получилась — не блокируем экспорт карты
        }

        // Map image placement
        const availableW = pageW - margin * 2;
        const availableH = pageH - headerH - margin;
        const ratio = Math.min(availableW / imgW, availableH / imgH);
        const drawW = imgW * ratio;
        const drawH = imgH * ratio;
        const x = margin + (availableW - drawW) / 2;
        const y = headerH + (availableH - drawH) / 2;
        pdf.addImage(mapPng, 'PNG', x, y, drawW, drawH, undefined, 'FAST');

        pdf.save(filename);
        this.notify('PDF сохранён', 'success');
    },

    // ========================
    // Карта: множественный выбор -> массовое редактирование
    // ========================

    async showMapBulkEditModal() {
        const list = (typeof MapManager !== 'undefined' && typeof MapManager.getMultiSelectedList === 'function')
            ? MapManager.getMultiSelectedList()
            : [];
        if (!list.length) {
            this.notify('Нет выбранных объектов', 'warning');
            return;
        }

        const content = `
            <form id="map-bulk-edit-form">
                <div class="form-group">
                    <label>Выбрано объектов</label>
                    <input type="text" value="${list.length}" disabled style="background: var(--bg-tertiary);">
                    <p class="text-muted">Используйте Ctrl+клик на карте для множественного выбора.</p>
                </div>
                <div class="form-group">
                    <label>Собственник</label>
                    <select id="bulk-owner-select">
                        <option value="">(не менять)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Состояние</label>
                    <select id="bulk-status-select">
                        <option value="">(не менять)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Примечания</label>
                    <textarea id="bulk-notes" rows="3" placeholder="(не менять)"></textarea>
                    <label style="display:flex; align-items:center; gap:8px; margin-top:8px; color: var(--text-secondary);">
                        <input type="checkbox" id="bulk-clear-notes">
                        Очистить примечания
                    </label>
                </div>
            </form>
        `;
        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.applyMapBulkEdit()">
                <i class="fas fa-check"></i> Применить
            </button>
        `;
        this.showModal('Массовое редактирование', content, footer);

        // Подгружаем справочники для селектов
        try {
            const [ownersResp, statusesResp] = await Promise.all([
                API.references.all('owners'),
                API.references.all('object_status'),
            ]);
            if (ownersResp?.success && document.getElementById('bulk-owner-select')) {
                document.getElementById('bulk-owner-select').innerHTML =
                    '<option value="">(не менять)</option>' +
                    ownersResp.data.map(o => `<option value="${o.id}">${this.escapeHtml(o.name || '')}</option>`).join('');
            }
            if (statusesResp?.success && document.getElementById('bulk-status-select')) {
                document.getElementById('bulk-status-select').innerHTML =
                    '<option value="">(не менять)</option>' +
                    statusesResp.data.map(s => `<option value="${s.id}">${this.escapeHtml(s.name || '')}</option>`).join('');
            }
        } catch (_) {
            // ignore
        }
    },

    async applyMapBulkEdit() {
        const list = (typeof MapManager !== 'undefined' && typeof MapManager.getMultiSelectedList === 'function')
            ? MapManager.getMultiSelectedList()
            : [];
        if (!list.length) {
            this.notify('Нет выбранных объектов', 'warning');
            return;
        }

        const ownerId = document.getElementById('bulk-owner-select')?.value || '';
        const statusId = document.getElementById('bulk-status-select')?.value || '';
        const notes = document.getElementById('bulk-notes')?.value ?? '';
        const clearNotes = !!document.getElementById('bulk-clear-notes')?.checked;

        const patch = {};
        if (ownerId) patch.owner_id = ownerId;
        if (statusId) patch.status_id = statusId;
        if (clearNotes) patch.notes = '';
        else if (String(notes).trim() !== '') patch.notes = String(notes);

        if (!Object.keys(patch).length) {
            this.notify('Не выбрано ни одного поля для изменения', 'warning');
            return;
        }

        const updateFnByType = {
            well: (id, data) => API.wells.update(id, data),
            channel_direction: (id, data) => API.channelDirections.update(id, data),
            marker_post: (id, data) => API.markerPosts.update(id, data),
            unified_cable: (id, data) => API.unifiedCables.update(id, data),
            ground_cable: (id, data) => API.cables.update('ground', id, data),
            aerial_cable: (id, data) => API.cables.update('aerial', id, data),
            duct_cable: (id, data) => API.cables.update('duct', id, data),
        };

        const results = { ok: 0, failed: 0 };
        for (const item of list) {
            const type = item?.objectType;
            const id = item?.properties?.id;
            const fn = updateFnByType[type];
            if (!fn || !id) {
                results.failed += 1;
                continue;
            }
            try {
                const resp = await fn(id, patch);
                if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                results.ok += 1;
            } catch (_) {
                results.failed += 1;
            }
        }

        this.hideModal();
        if (results.failed) this.notify(`Обновлено: ${results.ok}, ошибок: ${results.failed}`, 'warning');
        else this.notify(`Обновлено: ${results.ok}`, 'success');

        try { MapManager.clearMultiSelection?.(); } catch (_) {}
        try { MapManager.loadAllLayers?.(); } catch (_) {}
        try { this.loadObjects?.(); } catch (_) {}
    },

    async deleteMapMultiSelected() {
        const list = (typeof MapManager !== 'undefined' && typeof MapManager.getMultiSelectedList === 'function')
            ? MapManager.getMultiSelectedList()
            : [];
        if (!list.length) {
            this.notify('Нет выбранных объектов', 'warning');
            return;
        }
        if (!this.canDelete()) {
            this.notify('Недостаточно прав для удаления', 'error');
            return;
        }

        const cnt = list.length;
        if (!confirm(`Вы уверены, что хотите удалить выбранные объекты (${cnt})?`)) {
            return;
        }

        const deleteFnByType = {
            well: (id) => API.wells.delete(id),
            channel_direction: (id) => API.channelDirections.delete(id),
            marker_post: (id) => API.markerPosts.delete(id),
            unified_cable: (id) => API.unifiedCables.delete(id),
            ground_cable: (id) => API.cables.delete('ground', id),
            aerial_cable: (id) => API.cables.delete('aerial', id),
            duct_cable: (id) => API.cables.delete('duct', id),
        };

        // Порядок удаления при множественном выделении:
        // 1) каналы (cable_channel) 2) направления 3) колодцы
        const rank = (t) => {
            if (t === 'cable_channel') return 1;
            if (t === 'channel_direction') return 2;
            if (t === 'well') return 3;
            return 100;
        };
        const ordered = (list || []).slice().sort((a, b) => rank(a?.objectType) - rank(b?.objectType));

        const results = { ok: 0, failed: 0 };
        for (const item of ordered) {
            const type = item?.objectType;
            const id = item?.properties?.id;
            const fn = deleteFnByType[type];
            if (!fn || !id) {
                results.failed += 1;
                continue;
            }
            try {
                const resp = await fn(id);
                if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                results.ok += 1;
            } catch (_) {
                results.failed += 1;
            }
        }

        try { MapManager.clearMultiSelection?.(); } catch (_) {}
        try { MapManager.loadAllLayers?.(); } catch (_) {}
        try { this.loadObjects?.(); } catch (_) {}

        if (results.failed) this.notify(`Удалено: ${results.ok}, ошибок: ${results.failed}`, 'warning');
        else this.notify(`Удалено: ${results.ok}`, 'success');
    },

    async previewShortestDuctCablePath(startWell, endWell) {
        const sId = parseInt(startWell?.id || 0, 10);
        const eId = parseInt(endWell?.id || 0, 10);
        if (!sId || !eId) return;

        try {
            const excludeDirs = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
                ? MapManager.shortestDuctCableRouteDirectionIds
                : [];
            const resp = await API.channelDirections.shortestPath(sId, eId, excludeDirs);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const data = resp?.data || resp || {};
            const ids = Array.isArray(data.direction_ids) ? data.direction_ids : [];

            // Подсветим путь
            try {
                const planned = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
                    ? MapManager.shortestDuctCableRouteDirectionIds
                    : [];
                const highlightIds = this._uniqueIdsPreserveOrder([...(planned || []), ...(ids || [])]);
                if (highlightIds.length) {
                    const fc = await API.channelDirections.geojsonByIds(highlightIds);
                    if (fc && fc.type === 'FeatureCollection') {
                        MapManager.highlightFeatureCollection(fc);
                    }
                } else {
                    MapManager.clearHighlight?.();
                }
            } catch (_) {}

            const total = Number(data.total_length_m || 0).toFixed(2);
            const dirsCount = (Array.isArray(data.directions) ? data.directions.length : 0);
            const content = `
                <div class="info-row"><span class="info-label">Старт:</span> <span class="info-value">${this.escapeHtml(startWell?.number || String(sId))}</span></div>
                <div class="info-row"><span class="info-label">Конец:</span> <span class="info-value">${this.escapeHtml(endWell?.number || String(eId))}</span></div>
                <div class="info-row"><span class="info-label">Направлений:</span> <span class="info-value">${dirsCount}</span></div>
                <div class="info-row"><span class="info-label">Длина (м):</span> <span class="info-value">${total}</span></div>
                <p class="text-muted" style="margin-top:10px;">Путь подсвечен на карте. Нажмите “Создать”, чтобы выбрать каналы и открыть создание кабеля. После создания можно продолжать выбирать следующие колодцы — маршрут будет достраиваться в этот же кабель.</p>
            `;
            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-primary" onclick="App.createDuctCableFromShortestPath()">
                    <i class="fas fa-plus"></i> Создать кабель
                </button>
            `;
            this._shortestDuctCablePath = data;
            // Неблокирующее окно: сверху-справа, без затемнения карты
            this.showModal('Кабель в канализации по кратчайшему пути', content, footer, { nonBlocking: true, position: 'top-right' });
        } catch (e) {
            const msg = (e?.message || '').toString();
            if (/путь не найден/i.test(msg)) {
                this.notify('Выбранный объект недостижим', 'warning');
                try { MapManager.clearHighlight?.(); } catch (_) {}
                try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
                return;
            }
            this.notify(msg || 'Не удалось рассчитать путь', 'error');
        }
    },

    async appendShortestDuctCablePlannedSegmentAndPreviewNext(nextWell) {
        const nextId = parseInt(nextWell?.id || 0, 10);
        if (!nextId) return;
        if (!MapManager?.shortestDuctCableStartWell || !MapManager?.shortestDuctCableEndWell) return;
        if (MapManager.shortestDuctCableBusy) return;

        MapManager.shortestDuctCableBusy = true;
        try {
            // 1) Зафиксировать текущий сегмент (Start -> End) в "планируемом" маршруте
            const startWell = MapManager.shortestDuctCableStartWell;
            const endWell = MapManager.shortestDuctCableEndWell;
            const sId = parseInt(startWell?.id || 0, 10);
            const eId = parseInt(endWell?.id || 0, 10);
            if (!sId || !eId) return;

            let data = this._shortestDuctCablePath || null;
            const dataS = parseInt(data?.start_well_id || 0, 10);
            const dataE = parseInt(data?.end_well_id || 0, 10);
            if (!data || dataS !== sId || dataE !== eId) {
                const excludeDirs = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
                    ? MapManager.shortestDuctCableRouteDirectionIds
                    : [];
                const resp = await API.channelDirections.shortestPath(sId, eId, excludeDirs);
                if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                data = resp?.data || resp || {};
            }

            const dirs = Array.isArray(data?.directions) ? data.directions : [];
            if (!dirs.length) {
                this.notify('Выбранный объект недостижим', 'warning');
                try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
                return;
            }

            const segmentChannelIds = await this.pickChannelsForShortestPathDirections(dirs);
            if (!segmentChannelIds || !segmentChannelIds.length) return; // cancelled

            const segmentU = this._uniqueIdsPreserveOrder(segmentChannelIds);
            const segDirIds = this._uniqueIdsPreserveOrder(Array.isArray(data?.direction_ids) ? data.direction_ids : []);

            const existingCh = Array.isArray(MapManager?.shortestDuctCableRouteChannelIds)
                ? MapManager.shortestDuctCableRouteChannelIds
                : [];
            const existingChU = this._uniqueIdsPreserveOrder(existingCh);
            const usedCh = new Set(existingChU);
            const conflicts = segmentU.filter((id) => usedCh.has(id));
            if (conflicts.length) {
                this.notify('Выбранный объект недостижим', 'warning');
                return;
            }

            MapManager.shortestDuctCableRouteChannelIds = [...existingChU, ...segmentU];
            const prevDirIds = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
                ? MapManager.shortestDuctCableRouteDirectionIds
                : [];
            MapManager.shortestDuctCableRouteDirectionIds = this._uniqueIdsPreserveOrder([...(prevDirIds || []), ...(segDirIds || [])]);

            // Переносим "старт" на текущий end, чтобы следующий сегмент считался End -> Next
            MapManager.shortestDuctCableStartWell = { id: eId, number: endWell?.number || String(eId) };
            MapManager.shortestDuctCableEndWell = null;
            this._shortestDuctCablePath = null;
            this._resolveShortestChannelPick = null;
            try { this.hideModal(); } catch (_) {}

            // 2) Поставить новый end и пересчитать только следующий сегмент (PrevEnd -> Next)
            if (nextId === MapManager.shortestDuctCableStartWell.id) {
                this.notify('Следующий колодец должен отличаться от текущего', 'warning');
                return;
            }
            MapManager.shortestDuctCableEndWell = { id: nextId, number: (nextWell?.number || '').toString() };
            await this.previewShortestDuctCablePath(MapManager.shortestDuctCableStartWell, MapManager.shortestDuctCableEndWell);
        } catch (e) {
            const msg = (e?.message || '').toString();
            if (/путь не найден/i.test(msg)) {
                this.notify('Выбранный объект недостижим', 'warning');
                try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
                return;
            }
            this.notify(msg || 'Не удалось рассчитать путь', 'error');
        } finally {
            try { MapManager.shortestDuctCableBusy = false; } catch (_) {}
        }
    },

    _uniqueIdsPreserveOrder(ids) {
        const out = [];
        const seen = new Set();
        (ids || []).forEach((x) => {
            const n = parseInt(x, 10);
            if (!n) return;
            if (seen.has(n)) return;
            seen.add(n);
            out.push(n);
        });
        return out;
    },

    async pickChannelsForShortestPathDirections(dirs) {
        const selected = [];
        for (const d of (dirs || [])) {
            const chs = Array.isArray(d.channels) ? d.channels : [];
            if (!chs.length) {
                this.notify(`У направления ${d.number || d.id} нет каналов`, 'error');
                return null;
            }
            if (chs.length === 1) {
                selected.push(parseInt(chs[0].id, 10));
                continue;
            }

            const picked = await new Promise((resolve) => {
                this._resolveShortestChannelPick = resolve;
                // Подсветить направление, где выбираем канал (как выделение объекта)
                try {
                    const prev = MapManager?.selectedLayer?._igsMeta || null;
                    this._shortestPickPrevSelected = (prev && prev.objectType && prev.properties?.id)
                        ? { objectType: prev.objectType, id: prev.properties.id }
                        : null;
                } catch (_) {
                    this._shortestPickPrevSelected = null;
                }
                try { MapManager?.highlightSelectedObject?.('channel_direction', d.id); } catch (_) {}
                const content = `
                    <div class="text-muted" style="margin-bottom:8px;">Направление: <strong>${this.escapeHtml(d.number || String(d.id))}</strong></div>
                    <div style="max-height: 60vh; overflow:auto;">
                        ${(chs || []).map(ch => `
                            <button class="btn btn-secondary btn-block" style="margin-bottom:8px;" onclick="App.pickShortestPathChannel(${parseInt(ch.id, 10)})">
                                Канал ${ch.channel_number}
                            </button>
                        `).join('')}
                    </div>
                `;
                const footer = `<button class="btn btn-secondary" onclick="App.cancelShortestPathChannelPick()">Отмена</button>`;
                this.showModal('Выберите канал направления', content, footer, { nonBlocking: true, position: 'top-right' });
            });
            if (!picked) return null; // cancelled
            selected.push(parseInt(picked, 10));
        }
        return this._uniqueIdsPreserveOrder(selected);
    },

    async createDuctCableFromShortestPath() {
        const data = this._shortestDuctCablePath || null;
        if (!data) return;
        const dirs = Array.isArray(data.directions) ? data.directions : [];
        if (!dirs.length) {
            this.notify('Путь пустой', 'warning');
            return;
        }

        const selected = await this.pickChannelsForShortestPathDirections(dirs);
        if (!selected || !selected.length) return;
        // Страховка: маршрут не должен содержать повтор канала
        const selectedU = this._uniqueIdsPreserveOrder(selected);
        const selectedDirIds = this._uniqueIdsPreserveOrder(Array.isArray(data.direction_ids) ? data.direction_ids : []);

        // Если пользователь уже "нащёлкал" несколько сегментов до создания кабеля,
        // то часть маршрута уже лежит в MapManager.shortestDuctCableRouteChannelIds/DirectionIds.
        const plannedCh = Array.isArray(MapManager?.shortestDuctCableRouteChannelIds)
            ? MapManager.shortestDuctCableRouteChannelIds
            : [];
        const plannedDir = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
            ? MapManager.shortestDuctCableRouteDirectionIds
            : [];
        const plannedChU = this._uniqueIdsPreserveOrder(plannedCh);
        const usedCh = new Set(plannedChU);
        const conflicts = selectedU.filter((id) => usedCh.has(id));
        if (conflicts.length) {
            this.notify('Выбранный объект недостижим', 'warning');
            return;
        }
        const fullRouteChannels = [...plannedChU, ...selectedU];
        const fullRouteDirIds = this._uniqueIdsPreserveOrder([...(plannedDir || []), ...(selectedDirIds || [])]);

        this.hideModal();
        this._shortestDuctCablePath = null;
        this._resolveShortestChannelPick = null;
        // Запоминаем маршрут, чтобы после создания кабеля продолжать достраивать его по следующим колодцам
        this._shortestDuctCableCreateRouteChannelIds = fullRouteChannels.slice();
        this._shortestDuctCableCreateRouteDirectionIds = fullRouteDirIds.slice();
        await this.showAddDuctCableModalFromMap(fullRouteChannels);
    },

    async extendShortestDuctCableToWell(cableId, startWell, endWell) {
        const cid = parseInt(cableId || 0, 10);
        const sId = parseInt(startWell?.id || 0, 10);
        const eId = parseInt(endWell?.id || 0, 10);
        if (!cid || !sId || !eId) return;

        try {
            this.notify('Расчёт кратчайшего пути...', 'info');
            const excludeDirs = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
                ? MapManager.shortestDuctCableRouteDirectionIds
                : [];
            const resp = await API.channelDirections.shortestPath(sId, eId, excludeDirs);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const data = resp?.data || resp || {};
            const dirs = Array.isArray(data.directions) ? data.directions : [];
            if (!dirs.length) {
                this.notify('Выбранный объект недостижим', 'warning');
                try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
                return;
            }

            // Подсветим сегмент
            try {
                const ids = Array.isArray(data.direction_ids) ? data.direction_ids : [];
                if (ids.length) {
                    const fc = await API.channelDirections.geojsonByIds(ids);
                    if (fc && fc.type === 'FeatureCollection') {
                        MapManager.highlightFeatureCollection(fc);
                    }
                }
            } catch (_) {}

            const segmentChannelIds = await this.pickChannelsForShortestPathDirections(dirs);
            if (!segmentChannelIds || !segmentChannelIds.length) {
                try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
                return;
            }

            const existing = Array.isArray(MapManager?.shortestDuctCableRouteChannelIds)
                ? MapManager.shortestDuctCableRouteChannelIds
                : [];
            const existingU = this._uniqueIdsPreserveOrder(existing || []);
            const segmentU = this._uniqueIdsPreserveOrder(segmentChannelIds || []);
            const used = new Set(existingU);
            const conflicts = segmentU.filter((id) => used.has(id));
            if (conflicts.length) {
                // Нельзя использовать один и тот же канал дважды (UNIQUE в БД).
                // Значит выбранный колодец недостижим с учётом уже выбранного маршрута.
                try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
                try {
                    // вернём подсветку на текущий маршрут кабеля (если получится)
                    const fc = await API.unifiedCables.routeDirectionsGeojson(cid);
                    if (fc && fc.type === 'FeatureCollection') MapManager.highlightFeatureCollection(fc);
                } catch (_) {}
                this.notify('Выбранный объект недостижим', 'warning');
                return;
            }
            const newRoute = [...existingU, ...segmentU];

            const upd = await API.unifiedCables.update(cid, { route_channels: newRoute });
            if (upd?.success === false) throw new Error(upd?.message || 'Ошибка обновления кабеля');

            // обновим состояние режима
            try {
                MapManager.shortestDuctCableRouteChannelIds = newRoute;
                const segDirIds = this._uniqueIdsPreserveOrder(Array.isArray(data.direction_ids) ? data.direction_ids : []);
                const prevDirIds = Array.isArray(MapManager?.shortestDuctCableRouteDirectionIds)
                    ? MapManager.shortestDuctCableRouteDirectionIds
                    : [];
                MapManager.shortestDuctCableRouteDirectionIds = this._uniqueIdsPreserveOrder([...(prevDirIds || []), ...(segDirIds || [])]);
                MapManager.shortestDuctCableStartWell = { id: eId, number: endWell?.number || String(eId) };
                MapManager.shortestDuctCableEndWell = null;
            } catch (_) {}

            // Перерисуем слои карты (без изменения фокуса/зума) и подсветим весь маршрут кабеля
            try { await MapManager.loadAllLayers?.(); } catch (_) {}
            try {
                const fc = await API.unifiedCables.routeDirectionsGeojson(cid);
                if (fc && fc.type === 'FeatureCollection') {
                    MapManager.highlightFeatureCollection(fc);
                }
            } catch (_) {}

            this.notify('Участок добавлен в кабель', 'success');
            this.notify('Выберите следующий колодец для продолжения (или выключите режим)', 'info');
        } catch (e) {
            try { MapManager.shortestDuctCableEndWell = null; } catch (_) {}
            const msg = (e?.message || '').toString();
            if (/путь не найден/i.test(msg)) {
                this.notify('Выбранный объект недостижим', 'warning');
                return;
            }
            this.notify(msg || 'Не удалось достроить кабель', 'error');
        }
    },

    pickShortestPathChannel(id) {
        const fn = this._resolveShortestChannelPick;
        this._resolveShortestChannelPick = null;
        this.hideModal();
        // снимаем подсветку направления и восстанавливаем предыдущее выделение (если было)
        try {
            const prev = this._shortestPickPrevSelected || null;
            this._shortestPickPrevSelected = null;
            if (prev && prev.objectType && prev.id) MapManager?.highlightSelectedObject?.(prev.objectType, prev.id);
            else MapManager?.clearSelectedObject?.();
        } catch (_) {}
        if (typeof fn === 'function') fn(parseInt(id, 10));
    },

    cancelShortestPathChannelPick() {
        const fn = this._resolveShortestChannelPick;
        this._resolveShortestChannelPick = null;
        this.hideModal();
        // снимаем подсветку направления и восстанавливаем предыдущее выделение (если было)
        try {
            const prev = this._shortestPickPrevSelected || null;
            this._shortestPickPrevSelected = null;
            if (prev && prev.objectType && prev.id) MapManager?.highlightSelectedObject?.(prev.objectType, prev.id);
            else MapManager?.clearSelectedObject?.();
        } catch (_) {}
        if (typeof fn === 'function') fn(null);
    },

    // ========================
    // Карта: "Настройки по умолчанию" (персональные дефолты)
    // ========================

    async renderMapDefaultsPanel(hostEl) {
        const el = hostEl || document.getElementById('map-defaults');
        if (!el) return;

        // Перечитаем настройки, чтобы показать актуальные персональные дефолты
        await this.loadSettings().catch(() => {});

        // Загружаем справочники (кеш)
        if (!this._mapDefaultsCache) {
            try {
                const [objectTypesResp, objectKindsResp, statusesResp, ownersResp, contractsResp, cableTypesResp, cableCatalogResp] = await Promise.all([
                    API.references.all('object_types'),
                    API.references.all('object_kinds'),
                    API.references.all('object_status'),
                    API.references.all('owners'),
                    API.references.all('contracts'),
                    API.references.all('cable_types'),
                    API.references.all('cable_catalog'),
                ]);
                this._mapDefaultsCache = {
                    objectTypes: objectTypesResp?.data || [],
                    objectKinds: objectKindsResp?.data || [],
                    statuses: statusesResp?.data || [],
                    owners: ownersResp?.data || [],
                    contracts: contractsResp?.data || [],
                    cableTypes: cableTypesResp?.data || [],
                    cableCatalog: cableCatalogResp?.data || [],
                };
            } catch (_) {
                this._mapDefaultsCache = { objectTypes: [], objectKinds: [], statuses: [], owners: [], contracts: [], cableTypes: [], cableCatalog: [] };
            }
        }

        const { objectTypes, objectKinds, statuses, owners, contracts, cableTypes, cableCatalog } = this._mapDefaultsCache;

        const getDefaultByIsDefault = (arr) => (arr || []).find(x => !!x.is_default)?.id || '';
        const getCurrent = (key, fallbackId) => {
            const v = (this.settings?.[key] ?? '').toString();
            return v ? v : (fallbackId ? String(fallbackId) : '');
        };

        const options = (arr, current, labelFn) => {
            const list = (arr || []).slice();
            list.sort((a, b) => String(labelFn(a)).localeCompare(String(labelFn(b)), 'ru'));
            return `<option value="">(пусто)</option>` + list.map(x => {
                const id = String(x.id);
                const sel = (id === String(current)) ? 'selected' : '';
                return `<option value="${id}" ${sel}>${this.escapeHtml(labelFn(x))}</option>`;
            }).join('');
        };

        // "Тип по умолчанию" по видам объектов — динамически из справочника "Виды объектов"
        // object_types.reference_table:
        // - object_kinds -> берём из "Типы объектов" (object_kinds) в рамках object_type_id
        // - cable_types  -> берём из "Типы кабелей" (cable_types)
        const normalizeRefTable = (ot) => {
            const rt = (ot?.reference_table || '').toString().trim();
            if (rt) return rt;
            // fallback, если БД ещё без миграции
            const code = (ot?.code || '').toString();
            if (code === 'well' || code === 'channel' || code === 'marker') return 'object_kinds';
            if (code.startsWith('cable_')) return 'cable_types';
            return '';
        };

        const getRefOptions = (ot) => {
            const rt = normalizeRefTable(ot);
            if (rt === 'object_kinds') {
                const id = ot?.id;
                if (!id) return [];
                return (objectKinds || []).filter(k => String(k.object_type_id) === String(id));
            }
            if (rt === 'cable_types') return (cableTypes || []);
            return [];
        };

        const getLegacyFallbackSetting = (ot, rt) => {
            const code = (ot?.code || '').toString();
            if (rt === 'object_kinds') {
                if (code === 'well') return this.settings?.default_kind_id_well;
                if (code === 'marker') return this.settings?.default_kind_id_marker;
                if (code === 'channel') return this.settings?.default_kind_id_direction;
            }
            if (rt === 'cable_types') return this.settings?.default_cable_type_id;
            return '';
        };

        const typeDefaultsObjectTypes = (objectTypes || [])
            .filter(ot => {
                const rt = normalizeRefTable(ot);
                return rt === 'object_kinds' || rt === 'cable_types';
            })
            .slice()
            .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'ru'));

        const safeDomId = (s) => String(s || '').replace(/[^0-9A-Za-z_-]/g, '_');

        const renderTypeDefaultsBlock = () => {
            if (!typeDefaultsObjectTypes.length) return '';
            return typeDefaultsObjectTypes.map(ot => {
                const rt = normalizeRefTable(ot);
                const code = (ot?.code || '').toString();
                const key = `default_ref_${code}`;
                const list = getRefOptions(ot);
                const fallbackId = getDefaultByIsDefault(list);
                const legacy = (getLegacyFallbackSetting(ot, rt) ?? '').toString();
                const current = getCurrent(key, legacy || fallbackId);
                return `
                    <div class="form-group">
                        <label>${this.escapeHtml(ot?.name || ot?.code || '—')}</label>
                        <select id="md-ref-${safeDomId(code)}" data-setting-key="${this.escapeHtml(key)}">
                            ${options(list, current, x => x.name || x.code || x.id)}
                        </select>
                    </div>
                `;
            }).join('');
        };

        const curStatus = getCurrent('default_status_id', getDefaultByIsDefault(statuses));
        const curOwner = getCurrent('default_owner_id', getDefaultByIsDefault(owners));
        const curContract = getCurrent('default_contract_id', '');
        const curCableCatalog = getCurrent('default_cable_catalog_id', getDefaultByIsDefault(cableCatalog));

        el.innerHTML = `
            <div class="map-defaults-title">Настройки по умолчанию</div>
            ${renderTypeDefaultsBlock()}
            <div class="form-group">
                <label>Состояние</label>
                <select id="md-status">${options(statuses, curStatus, x => x.name || x.code || x.id)}</select>
            </div>
            <div class="form-group">
                <label>Собственник</label>
                <select id="md-owner">${options(owners, curOwner, x => x.name || x.code || x.id)}</select>
            </div>
            <div class="form-group">
                <label>Контракт</label>
                <select id="md-contract">${options(contracts, curContract, x => (x.number ? `${x.number} — ${x.name || ''}` : (x.name || x.id)))}</select>
            </div>
            <div class="form-group">
                <label>Кабель</label>
                <select id="md-cable-catalog">${options(cableCatalog, curCableCatalog, x => (x.marking ? `${x.marking} (${x.fiber_count || '-'} вол.)` : (x.id || '')))}</select>
            </div>
            <div class="text-muted">Изменения сохраняются персонально для текущего пользователя.</div>
        `;

        const bindSave = (selectId, key) => {
            const s = document.getElementById(selectId);
            if (!s) return;
            s.addEventListener('change', async () => {
                const value = s.value || '';
                try {
                    const resp = await API.settings.update({ [key]: value });
                    if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                    // обновим локально
                    await this.loadSettings().catch(() => {});
                    this.notify('Сохранено', 'success');
                } catch (e) {
                    this.notify(e?.message || 'Ошибка сохранения', 'error');
                }
            });
        };

        // Динамические поля по видам объектов
        el.querySelectorAll('select[id^="md-ref-"][data-setting-key]').forEach((s) => {
            s.addEventListener('change', async () => {
                const key = s.getAttribute('data-setting-key') || '';
                if (!key) return;
                const value = s.value || '';
                try {
                    const resp = await API.settings.update({ [key]: value });
                    if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
                    await this.loadSettings().catch(() => {});
                    this.notify('Сохранено', 'success');
                } catch (e) {
                    this.notify(e?.message || 'Ошибка сохранения', 'error');
                }
            });
        });

        bindSave('md-status', 'default_status_id');
        bindSave('md-owner', 'default_owner_id');
        bindSave('md-contract', 'default_contract_id');
        bindSave('md-cable-catalog', 'default_cable_catalog_id');
    },

    /**
     * Модальное окно добавления объекта
     */
    showAddObjectModal(type, lat = null, lng = null) {
        const titles = {
            wells: 'Добавить колодец',
            directions: 'Добавить направление',
            channels: 'Добавить канал',
            markers: 'Добавить столбик',
            cables: 'Добавить кабель',
            groups: 'Создать карточку ТУ',
            unified_cables: 'Добавить кабель',
        };

        // Соответствие типа объекта коду вида объекта
        const objectTypeCodes = {
            wells: 'well',
            markers: 'marker',
            directions: 'channel',
            cables: 'ground_cable',
        };

        let formHtml = '';

        if (type === 'wells') {
            formHtml = `
                <form id="add-object-form">
                    <input type="hidden" name="object_type_code" value="${objectTypeCodes[type] || ''}">
                    <div class="form-group">
                        <label>Номер *</label>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input type="text" id="modal-number-prefix" readonly style="flex: 0 0 240px; background: var(--bg-tertiary);" value="...">
                            <input type="text" id="modal-number-seq-preview" disabled style="flex: 0 0 110px; background: var(--bg-tertiary);" value="Авто">
                            <input type="text" name="number_suffix" id="modal-number-suffix" maxlength="5" placeholder="Суффикс (до 5)" style="flex: 1;">
                        </div>
                        <p class="text-muted">Номер формируется автоматически: <код номера>-<код собственника>-<минимальный свободный номер>(-суффикс).</p>
                    </div>
                    <div id="coords-wgs84-inputs">
                        <div class="form-group">
                            <label>Широта (WGS84)</label>
                            <input type="number" name="latitude" step="0.000001" value="${lat || ''}" placeholder="55.123456">
                        </div>
                        <div class="form-group">
                            <label>Долгота (WGS84)</label>
                            <input type="number" name="longitude" step="0.000001" value="${lng || ''}" placeholder="37.123456">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Собственник *</label>
                        <select name="owner_id" required id="modal-owner-select"></select>
                    </div>
                    <div class="form-group" style="display: none;">
                        <label>Вид *</label>
                        <select name="type_id" required id="modal-type-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Тип *</label>
                        <select name="kind_id" required id="modal-kind-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Состояние *</label>
                        <select name="status_id" required id="modal-status-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Примечания</label>
                        <textarea name="notes" rows="3"></textarea>
                    </div>
                </form>
            `;
        } else if (type === 'markers') {
            formHtml = `
                <form id="add-object-form">
                    <input type="hidden" name="object_type_code" value="${objectTypeCodes[type] || ''}">
                    <div class="form-group">
                        <label>Номер *</label>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input type="text" id="modal-number-prefix" readonly style="flex: 0 0 240px; background: var(--bg-tertiary);" value="...">
                            <input type="text" id="modal-number-seq-preview" disabled style="flex: 0 0 110px; background: var(--bg-tertiary);" value="Авто">
                            <input type="text" name="number_suffix" id="modal-number-suffix" maxlength="5" placeholder="Суффикс (до 5)" style="flex: 1;">
                        </div>
                        <p class="text-muted">Номер формируется автоматически: <код номера>-<код собственника>-<минимальный свободный номер>(-суффикс).</p>
                    </div>
                    <div id="coords-wgs84-inputs">
                        <div class="form-group">
                            <label>Широта (WGS84)</label>
                            <input type="number" name="latitude" step="0.000001" value="${lat || ''}" placeholder="55.123456">
                        </div>
                        <div class="form-group">
                            <label>Долгота (WGS84)</label>
                            <input type="number" name="longitude" step="0.000001" value="${lng || ''}" placeholder="37.123456">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Собственник *</label>
                        <select name="owner_id" required id="modal-owner-select"></select>
                    </div>
                    <div class="form-group" style="display: none;">
                        <label>Вид *</label>
                        <select name="type_id" required id="modal-type-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Тип *</label>
                        <select name="kind_id" required id="modal-kind-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Состояние *</label>
                        <select name="status_id" required id="modal-status-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Дата установки</label>
                        <input type="date" name="installation_date">
                    </div>
                    <div class="form-group">
                        <label>Примечания</label>
                        <textarea name="notes" rows="3"></textarea>
                    </div>
                </form>
            `;
        } else if (type === 'directions') {
            formHtml = `
                <form id="add-object-form">
                    <input type="hidden" name="object_type_code" value="channel">
                    <div class="form-group">
                        <label>Номер *</label>
                        <input type="text" name="number" required readonly style="background: var(--bg-tertiary);">
                    </div>
                    <div class="form-group">
                        <label>Начальный колодец *</label>
                        <select name="start_well_id" required id="modal-start-well-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Конечный колодец *</label>
                        <select name="end_well_id" required id="modal-end-well-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Количество каналов</label>
                        <input type="number" name="channel_count" min="1" max="16" value="1">
                    </div>
                    <div class="form-group">
                        <label>Собственник</label>
                        <select name="owner_id" id="modal-owner-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Состояние</label>
                        <select name="status_id" id="modal-status-select"></select>
                    </div>
                    <div class="form-group" style="display: none;">
                        <label>Вид</label>
                        <select name="type_id" id="modal-type-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Длина (м)</label>
                        <input type="number" name="length_m" step="0.01" disabled style="background: var(--bg-tertiary);" placeholder="Авто-расчёт">
                    </div>
                    <div class="form-group">
                        <label>Примечания</label>
                        <textarea name="notes" rows="3"></textarea>
                    </div>
                </form>
            `;
        } else if (type === 'channels') {
            formHtml = `
                <form id="add-object-form">
                    <div class="form-group">
                        <label>Направление *</label>
                        <select name="direction_id" required id="modal-direction-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Номер канала (1-16)</label>
                        <input type="number" name="channel_number" min="1" max="16" placeholder="Авто">
                    </div>
                    <div class="form-group">
                        <label>Тип</label>
                        <select name="kind_id" id="modal-kind-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Состояние</label>
                        <select name="status_id" id="modal-status-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Диаметр (мм)</label>
                        <input type="number" name="diameter_mm" value="110">
                    </div>
                    <div class="form-group">
                        <label>Примечания</label>
                        <textarea name="notes" rows="3"></textarea>
                    </div>
                </form>
            `;
        } else if (type === 'groups') {
            formHtml = `
                <form id="add-object-form">
                    <div class="form-group">
                        <label>Номер</label>
                        <input type="text" name="number" value="(авто)" disabled style="background: var(--bg-tertiary);">
                    </div>
                    <div class="form-group">
                        <label>Дата</label>
                        <input type="date" name="tu_date">
                    </div>
                    <div class="form-group">
                        <label>Название *</label>
                        <input type="text" name="name" required>
                    </div>
                    <div class="form-group">
                        <label>Основание (Запрос)</label>
                        <input type="text" name="request_basis" maxlength="100" placeholder="(необязательно)">
                    </div>
                    <div class="form-group">
                        <label>Тип ТУ</label>
                        <input type="text" name="group_type">
                    </div>
                    <div class="form-group">
                        <label>Описание</label>
                        <textarea name="description" rows="3"></textarea>
                    </div>
                    <div class="form-group">
                        <label>Объекты в ТУ</label>
                        <div id="group-objects-container">
                            <p class="text-muted">Объекты можно добавить после создания ТУ</p>
                        </div>
                    </div>
                    <hr>
                    <h4>Вложения (файлы)</h4>
                    <div class="form-group">
                        <label>Добавить файлы</label>
                        <input type="file" id="tu-attachments-files" multiple>
                        <div id="tu-attachments-pending" class="text-muted" style="margin-top: 8px;">Файлы не выбраны</div>
                        <p class="text-muted" style="margin-top: 8px;">Файлы будут загружены после создания ТУ</p>
                    </div>
                </form>
            `;
        } else if (type === 'unified_cables') {
            formHtml = `
                <form id="add-object-form">
                    <div class="form-group">
                        <label>Номер *</label>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <input type="text" id="modal-number-prefix" readonly style="flex: 0 0 260px; background: var(--bg-tertiary);" value="...">
                            <input type="text" id="modal-number-seq-preview" disabled style="flex: 0 0 110px; background: var(--bg-tertiary);" value="Авто">
                            <input type="text" name="number_suffix" id="modal-number-suffix" maxlength="5" placeholder="Суффикс (до 5)" style="flex: 1;">
                        </div>
                        <p class="text-muted">Номер формируется автоматически: <код номера>-<код собственника>-<минимальный свободный номер>(-суффикс).</p>
                    </div>
                    <div class="form-group">
                        <label>Вид объекта *</label>
                        <select name="object_type_id" required id="modal-cable-object-type" onchange="App.onCableObjectTypeChange()">
                            <option value="">Выберите вид...</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Тип кабеля *</label>
                        <select name="cable_type_id" required id="modal-cable-type-select" onchange="App.onCableTypeChange()">
                            <option value="">Выберите тип...</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Кабель (из каталога)</label>
                        <select name="cable_catalog_id" id="modal-cable-catalog-select">
                            <option value="">Выберите марку кабеля...</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Собственник *</label>
                        <select name="owner_id" required id="modal-owner-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Контракт</label>
                        <select name="contract_id" id="modal-contract-select">
                            <option value="">Не указан</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Состояние</label>
                        <select name="status_id" id="modal-status-select"></select>
                    </div>
                    
                    <!-- Блок для кабелей в грунте и воздушных (координаты) -->
                    <div id="cable-geometry-block" style="display: none;">
                        <div class="form-group">
                            <label>Координаты (точки ломаной)</label>
                            <div id="cable-coordinates-list"></div>
                            <button type="button" class="btn btn-sm btn-secondary" onclick="App.addCableCoordinate()">
                                <i class="fas fa-plus"></i> Добавить точку
                            </button>
                        </div>
                    </div>
                    
                    <!-- Блок для кабелей в канализации (маршрут) -->
                    <div id="cable-route-block" style="display: none;">
                        <div class="form-group">
                            <label>Каналы маршрута</label>
                            <select multiple id="cable-route-channels" style="height: 100px; width: 100%;">
                            </select>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Дата установки</label>
                        <input type="date" name="installation_date">
                    </div>
                    <div class="form-group">
                        <label>Примечания</label>
                        <textarea name="notes" rows="3"></textarea>
                    </div>
                </form>
            `;
        }

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitAddObject('${type}')">Сохранить</button>
        `;

        this.showModal(titles[type] || 'Добавить объект', formHtml, footer);

        // ТУ: сохраняем выбранные вложения до создания
        if (type === 'groups') {
            this._pendingGroupAttachments = [];
            const fileInput = document.getElementById('tu-attachments-files');
            const pendingEl = document.getElementById('tu-attachments-pending');
            if (fileInput) {
                fileInput.addEventListener('change', () => {
                    const files = Array.from(fileInput.files || []);
                    this._pendingGroupAttachments = files;
                    if (pendingEl) {
                        pendingEl.textContent = files.length
                            ? `Выбрано файлов: ${files.length} (${files.map(f => f.name).join(', ')})`
                            : 'Файлы не выбраны';
                    }
                });
            }
        }
        
        // Загружаем справочники для селектов
        this.loadModalSelects(type);
    },

    /**
     * Переключение полей ввода координат
     */
    toggleCoordinateInputs() {
        // MSK86 отключён. Оставлено для обратной совместимости.
        const wgs84Inputs = document.getElementById('coords-wgs84-inputs');
        if (wgs84Inputs) wgs84Inputs.style.display = 'block';
    },

    /**
     * Загрузка селектов в модальном окне
     */
    async loadModalSelects(objectType = null) {
        try {
            const promises = [
                API.references.all('owners'),
                API.references.all('object_types'),
                API.references.all('object_kinds'),
                API.references.all('object_status'),
            ];

            // Для направлений загружаем список колодцев
            if (objectType === 'directions') {
                promises.push(API.wells.list({ limit: 1000 }));
            }
            
            // Для каналов загружаем список направлений
            if (objectType === 'channels') {
                promises.push(API.channelDirections.list({ limit: 1000 }));
            }

            // Для унифицированных кабелей загружаем типы кабелей
            if (objectType === 'unified_cables') {
                promises.push(API.references.all('cable_types'));
                promises.push(API.unifiedCables.objectTypes());
                promises.push(API.references.all('contracts'));
            }

            const results = await Promise.all(promises);
            const [owners, types, kinds, statuses] = results;
            
            const pickDefault = (selectEl) => {
                if (!selectEl) return;
                if (selectEl.value) return;
                const opt = Array.from(selectEl.options).find(o => o?.dataset?.isDefault === '1' && o.value);
                if (opt) {
                    selectEl.value = opt.value;
                    selectEl.dispatchEvent(new Event('change'));
                }
            };

            const pickUserDefault = (selectEl, value, opts = {}) => {
                if (!selectEl) return false;
                if (selectEl.dataset?.value) return false; // edit form value wins
                if (!value) return false;
                const exists = Array.from(selectEl.options).some(o => String(o.value) === String(value));
                if (!exists) return false;
                // Если уже выбрано значение, обычно не трогаем.
                // Но для селектов, где система сама подставляет is_default, персональный дефолт должен иметь приоритет.
                if (selectEl.value) {
                    const canOverrideDefault =
                        !!opts.forceIfDefault &&
                        (selectEl.selectedOptions?.[0]?.dataset?.isDefault === '1');
                    if (!canOverrideDefault) return false;
                }
                selectEl.value = String(value);
                selectEl.dispatchEvent(new Event('change'));
                return true;
            };

            // Определяем код вида объекта из скрытого поля
            const objectTypeCode = document.querySelector('input[name="object_type_code"]')?.value;

            if (owners.success && document.getElementById('modal-owner-select')) {
                document.getElementById('modal-owner-select').innerHTML = 
                    '<option value="">Выберите...</option>' +
                    owners.data.map(o => `<option value="${o.id}" data-code="${o.code || ''}" data-is-default="${o.is_default ? 1 : 0}">${o.name}</option>`).join('');
                const sel = document.getElementById('modal-owner-select');
                const udef = this.settings?.default_owner_id || '';
                if (!pickUserDefault(sel, udef)) pickDefault(sel);
            }

            // Обновление префикса номера по выбранному собственнику
            const ownerSelect = document.getElementById('modal-owner-select');
            const prefixInput = document.getElementById('modal-number-prefix');
            const suffixInput = document.getElementById('modal-number-suffix');

            const buildPrefix = () => {
                const ownerCode = ownerSelect?.selectedOptions?.[0]?.dataset?.code || '';
                if (!ownerCode) return '';

                // Код номера берём из выбранного вида объекта (object_types.number_code) или из вида кабеля
                let numberCode = '';
                if (objectType === 'unified_cables') {
                    const otSel = document.getElementById('modal-cable-object-type');
                    numberCode = otSel?.selectedOptions?.[0]?.dataset?.numberCode || '';
                } else {
                    numberCode = document.getElementById('modal-type-select')?.selectedOptions?.[0]?.dataset?.numberCode || '';
                }
                numberCode = (numberCode || '').toString().trim();
                if (!numberCode) return '';

                return `${numberCode}-${ownerCode}-`;
            };

            const updateNumberUi = () => {
                if (!prefixInput || !ownerSelect) return;
                const pref = buildPrefix();
                prefixInput.value = pref || '...';
            };

            if (ownerSelect && prefixInput) {
                ownerSelect.addEventListener('change', () => {
                    updateNumberUi();
                });
                // unified cables: префикс зависит от выбранного object_type_id
                document.getElementById('modal-cable-object-type')?.addEventListener('change', () => {
                    updateNumberUi();
                });
                document.getElementById('modal-type-select')?.addEventListener('change', () => {
                    updateNumberUi();
                });

                updateNumberUi();
            }
            
            if (types.success && document.getElementById('modal-type-select')) {
                const typeSelect = document.getElementById('modal-type-select');
                typeSelect.innerHTML = types.data.map(t => 
                    `<option value="${t.id}" data-code="${t.code}" data-number-code="${t.number_code || t.code || ''}" data-is-default="${t.is_default ? 1 : 0}">${t.name}</option>`
                ).join('');
                
                // Персональные дефолты по "Вид" (object_types)
                const byObj = {
                    wells: this.settings?.default_type_id_well,
                    markers: this.settings?.default_type_id_marker,
                    directions: this.settings?.default_type_id_direction,
                };
                const udefType = byObj[objectType] || '';
                if (pickUserDefault(typeSelect, udefType)) {
                    this.filterKindsByType(typeSelect.value, kinds.data);
                } else if (objectTypeCode) {
                    // Автоматически выбираем вид объекта по коду
                    const matchingType = types.data.find(t => t.code === objectTypeCode);
                    if (matchingType) {
                        typeSelect.value = matchingType.id;
                        this.filterKindsByType(matchingType.id, kinds.data);
                        // важно: инициируем обновление UI (в т.ч. префикса номера)
                        typeSelect.dispatchEvent(new Event('change'));
                    }
                } else {
                    pickDefault(typeSelect);
                }
            }
            
            if (kinds.success && document.getElementById('modal-kind-select')) {
                // Сохраняем все типы для фильтрации
                this.allKinds = kinds.data;
                let kindsHandled = false;
                
                // Для "Каналы" (cable_channels) вид объекта в форме не выбирается —
                // берём дефолтные типы в рамках object_types.code === 'channel'
                if (objectType === 'channels' && !document.getElementById('modal-type-select')) {
                    const channelType = (types?.data || []).find(t => t.code === 'channel');
                    const channelTypeId = channelType?.id || null;
                    const filtered = channelTypeId
                        ? (kinds.data || []).filter(k => String(k.object_type_id) === String(channelTypeId))
                        : (kinds.data || []);
                    const kindSelect = document.getElementById('modal-kind-select');
                    kindSelect.innerHTML = '<option value="">Выберите...</option>' +
                        filtered.map(k => `<option value="${k.id}" data-code="${this.escapeHtml(k.code || '')}" data-is-default="${k.is_default ? 1 : 0}">${this.escapeHtml(k.name || '')}</option>`).join('');
                    // Персональный дефолт для каналов берём из map-defaults: default_ref_channel
                    const udef = this.settings?.default_ref_channel || '';
                    if (!pickUserDefault(kindSelect, udef, { forceIfDefault: true })) pickDefault(kindSelect);
                    kindsHandled = true;
                }

                // Если уже выбран вид, фильтруем типы
                const typeSelect = document.getElementById('modal-type-select');
                if (!kindsHandled && typeSelect && typeSelect.value) {
                    this.filterKindsByType(typeSelect.value, kinds.data);
                } else if (!kindsHandled) {
                    document.getElementById('modal-kind-select').innerHTML = 
                        '<option value="">Выберите...</option>' +
                        kinds.data.map(k => `<option value="${k.id}" data-code="${this.escapeHtml(k.code || '')}" data-is-default="${k.is_default ? 1 : 0}">${this.escapeHtml(k.name || '')}</option>`).join('');
                    pickDefault(document.getElementById('modal-kind-select'));
                }

                // Персональные дефолты по "Тип" (object_kinds):
                // - новый формат: default_ref_<object_type_code> (например default_ref_well)
                // - fallback: старые ключи default_kind_id_*
                const kindSelect = document.getElementById('modal-kind-select');
                const byObjKindLegacy = {
                    wells: this.settings?.default_kind_id_well,
                    markers: this.settings?.default_kind_id_marker,
                    directions: this.settings?.default_kind_id_direction,
                };
                // Для "Каналы" (cable_channels) используем фиксированный ключ default_ref_channel
                const refKey = (objectType === 'channels')
                    ? 'default_ref_channel'
                    : (objectTypeCode ? `default_ref_${String(objectTypeCode)}` : '');
                const udefKind = (refKey && this.settings?.[refKey]) ? this.settings?.[refKey] : (byObjKindLegacy[objectType] || '');
                if (kindSelect) {
                    if (!pickUserDefault(kindSelect, udefKind, { forceIfDefault: true })) pickDefault(kindSelect);
                }
                try {
                    // после заполнения kinds проверяем правило "ввод в здание" -> собственник "Не указан"
                    this.enforceInputWellOwnerInModal?.();
                    if (!kindSelect?._igsBoundEnforceInputOwner) {
                        kindSelect._igsBoundEnforceInputOwner = true;
                        kindSelect.addEventListener('change', () => this.enforceInputWellOwnerInModal?.());
                    }
                    const ownerSelect = document.getElementById('modal-owner-select');
                    if (ownerSelect && !ownerSelect._igsBoundEnforceInputOwner) {
                        ownerSelect._igsBoundEnforceInputOwner = true;
                        ownerSelect.addEventListener('change', () => this.enforceInputWellOwnerInModal?.());
                    }
                } catch (_) {}
            }
            
            if (statuses.success && document.getElementById('modal-status-select')) {
                const statusSelect = document.getElementById('modal-status-select');
                statusSelect.innerHTML = 
                    '<option value="">Выберите...</option>' +
                    statuses.data.map(s => `<option value="${s.id}" data-code="${s.code || ''}" data-is-default="${s.is_default ? 1 : 0}">${s.name}</option>`).join('');
                // Режим ТУ: по умолчанию planned
                const canAutoPlanned =
                    !!this.tuModeEnabled &&
                    !!this.tuModeGroupId &&
                    !statusSelect.dataset?.value &&
                    !statusSelect.value;
                if (canAutoPlanned) {
                    const planned = Array.from(statusSelect.options).find(o => (o?.dataset?.code || '') === 'planned' && o.value);
                    if (planned) {
                        statusSelect.value = planned.value;
                        statusSelect.dispatchEvent(new Event('change'));
                    } else {
                        const udef = this.settings?.default_status_id || '';
                        if (!pickUserDefault(statusSelect, udef)) pickDefault(statusSelect);
                    }
                } else {
                    const udef = this.settings?.default_status_id || '';
                    if (!pickUserDefault(statusSelect, udef)) pickDefault(statusSelect);
                }
            }

            // Контракты (для кабеля при редактировании)
            const contractSelect = document.getElementById('modal-contract-select');
            if (objectType === 'unified_cables' && contractSelect) {
                const contractsResp = results.find(r => r?.data && Array.isArray(r.data) && r.data[0]?.number !== undefined && r.data[0]?.name !== undefined) || null;
                // Если не удалось эвристикой — берём по индексу (owners/types/kinds/statuses + cable_types + objectTypes + contracts)
                const idxContracts = 6; // 0..3 base, 4 cable_types, 5 objectTypes, 6 contracts
                const cResp = results[idxContracts] || contractsResp;
                if (cResp?.success) {
                    contractSelect.innerHTML = '<option value="">Не указан</option>' +
                        cResp.data.map(c => `<option value="${c.id}" data-is-default="${c.is_default ? 1 : 0}">${c.number} — ${c.name}</option>`).join('');
                    const udef = this.settings?.default_contract_id || '';
                    if (!pickUserDefault(contractSelect, udef, { forceIfDefault: true })) pickDefault(contractSelect);
                }
            }

            // Для направлений - загружаем колодцы
            if (objectType === 'directions' && results[4]) {
                const wellsResponse = results[4];
                if (wellsResponse.success !== false) {
                    const wells = wellsResponse.data || wellsResponse;
                    const wellOptions = '<option value="">Выберите колодец...</option>' +
                        wells.map(w => `<option value="${w.id}">${w.number}</option>`).join('');
                    
                    if (document.getElementById('modal-start-well-select')) {
                        document.getElementById('modal-start-well-select').innerHTML = wellOptions;
                    }
                    if (document.getElementById('modal-end-well-select')) {
                        document.getElementById('modal-end-well-select').innerHTML = wellOptions;
                    }

                    // Автозаполнение номера направления по выбранным колодцам (start-end)
                    const startSelect = document.getElementById('modal-start-well-select');
                    const endSelect = document.getElementById('modal-end-well-select');
                    const numberInput = document.querySelector('#add-object-form input[name="number"]');
                    if (numberInput) {
                        numberInput.readOnly = true;
                        numberInput.style.background = 'var(--bg-tertiary)';
                    }
                    const updateNumber = () => {
                        if (!numberInput || !startSelect || !endSelect) return;
                        const startId = startSelect.value;
                        const endId = endSelect.value;
                        const startText = startSelect.selectedOptions?.[0]?.textContent?.trim() || '';
                        const endText = endSelect.selectedOptions?.[0]?.textContent?.trim() || '';
                        if (startId && endId && startText && endText) {
                            numberInput.value = `${startText}-${endText}`;
                        } else {
                            numberInput.value = '';
                        }
                    };
                    if (startSelect && endSelect && numberInput) {
                        startSelect.onchange = updateNumber;
                        endSelect.onchange = updateNumber;
                        updateNumber();
                    }
                }
            }

            // Для каналов - загружаем направления
            if (objectType === 'channels' && results[4]) {
                const directionsResponse = results[4];
                if (directionsResponse.success !== false) {
                    const directions = directionsResponse.data || directionsResponse;
                    const dirOptions = '<option value="">Выберите направление...</option>' +
                        directions.map(d => `<option value="${d.id}">${d.number} (${d.start_well_number} → ${d.end_well_number})</option>`).join('');
                    
                    if (document.getElementById('modal-direction-select')) {
                        document.getElementById('modal-direction-select').innerHTML = dirOptions;
                    }
                }
            }

            // Для унифицированных кабелей - загружаем типы кабелей и виды объектов
            if (objectType === 'unified_cables') {
                const cableTypesResponse = results[4];
                const cableObjectTypesResponse = results[5];
                
                // Типы кабелей
                if (cableTypesResponse?.success && document.getElementById('modal-cable-type-select')) {
                    document.getElementById('modal-cable-type-select').innerHTML = 
                        '<option value="">Выберите тип...</option>' +
                        cableTypesResponse.data.map(ct => `<option value="${ct.id}" data-is-default="${ct.is_default ? 1 : 0}">${ct.name}</option>`).join('');
                    const sel = document.getElementById('modal-cable-type-select');
                    const udefCt = this.settings?.default_cable_type_id || '';
                    if (sel && !sel.value) {
                        if (!pickUserDefault(sel, udefCt)) {
                            const def = (cableTypesResponse.data || []).find(ct => ct.is_default);
                            if (def) {
                                sel.value = String(def.id);
                                this.onCableTypeChange().catch(() => {});
                            }
                        } else {
                            this.onCableTypeChange().catch(() => {});
                        }
                    }
                }
                
                // Виды объектов для кабелей
                if (cableObjectTypesResponse?.success && document.getElementById('modal-cable-object-type')) {
                    document.getElementById('modal-cable-object-type').innerHTML = 
                        '<option value="">Выберите вид...</option>' +
                        cableObjectTypesResponse.data.map(ot => 
                            `<option value="${ot.id}" data-code="${ot.code}" data-number-code="${ot.number_code || ot.code || ''}" data-is-default="${ot.is_default ? 1 : 0}">${ot.name}</option>`
                        ).join('');

                    // Выбираем дефолтный вид кабеля (is_default=1), иначе первый доступный
                    const sel = document.getElementById('modal-cable-object-type');
                    if (sel && !sel.value) {
                        const def = Array.from(sel.options).find(o => o?.dataset?.isDefault === '1' && o.value);
                        if (def) {
                            sel.value = def.value;
                            sel.dispatchEvent(new Event('change'));
                        } else {
                            const first = Array.from(sel.options).find(o => o.value);
                            if (first) {
                                sel.value = first.value;
                                sel.dispatchEvent(new Event('change'));
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Ошибка загрузки справочников:', error);
        }
    },

    /**
     * Фильтрация типов (kinds) по виду объекта
     */
    filterKindsByType(typeId, allKinds = null) {
        const kinds = allKinds || this.allKinds || [];
        const kindSelect = document.getElementById('modal-kind-select');
        
        if (!kindSelect) return;
        
        const filteredKinds = kinds.filter(k => 
            !k.object_type_id || k.object_type_id == typeId
        );
        
        kindSelect.innerHTML = '<option value="">Выберите...</option>' +
            filteredKinds.map(k => `<option value="${k.id}" data-code="${this.escapeHtml(k.code || '')}" data-is-default="${k.is_default ? 1 : 0}">${this.escapeHtml(k.name || '')}</option>`).join('');

        // Автовыбор значения по умолчанию (если ничего не выбрано)
        if (!kindSelect.value) {
            const def = filteredKinds.find(k => k.is_default);
            if (def) kindSelect.value = String(def.id);
        }
        try { this.enforceInputWellOwnerInModal?.(); } catch (_) {}
    },

    enforceInputWellOwnerInModal() {
        try {
            const kindSelect = document.getElementById('modal-kind-select');
            const ownerSelect = document.getElementById('modal-owner-select');
            if (!kindSelect || !ownerSelect) return;

            const entryCode = (this.settings?.well_entry_point_kind_code ?? 'input').toString().trim().toLowerCase();
            const kindCode = (kindSelect.selectedOptions?.[0]?.dataset?.code || '').toString().trim().toLowerCase();
            const isEntry = !!entryCode && !!kindCode && (kindCode === entryCode);

            const defaultOpt = Array.from(ownerSelect.options || []).find(o => {
                const oc = (o?.dataset?.code || '').toString().trim().toLowerCase();
                const txt = (o?.textContent || '').toString().trim().toLowerCase();
                return oc === 'default' || txt.includes('не указан');
            });
            const defaultOwnerId = defaultOpt?.value ? String(defaultOpt.value) : '';

            if (isEntry && defaultOwnerId) {
                // Выставляем "Не указан" и блокируем выбор (на сервере тоже принудительно)
                ownerSelect.value = defaultOwnerId;
                try { ownerSelect.dispatchEvent(new Event('change')); } catch (_) {}
                ownerSelect.disabled = true;
                ownerSelect.title = 'Для типа "Ввод в здание" собственник задаётся автоматически: "Не указан"';
                try { ownerSelect.style.background = 'var(--bg-tertiary)'; } catch (_) {}
                return;
            }

            // Иначе — разблокируем
            if (ownerSelect.disabled) {
                ownerSelect.disabled = false;
                ownerSelect.title = '';
                try { ownerSelect.style.background = ''; } catch (_) {}
            }
        } catch (_) {
            // ignore
        }
    },

    /**
     * Отправка формы добавления объекта
     */
    async submitAddObject(type) {
        const form = document.getElementById('add-object-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        
        // Удаляем служебное поле
        delete data.object_type_code;
        // Номер формируется на сервере (по диапазонам собственника + коду номера).

        try {
            let response;
            
            switch (type) {
                case 'wells':
                    response = await API.wells.create(data);
                    break;
                case 'markers':
                    response = await API.markerPosts.create(data);
                    break;
                case 'directions':
                    response = await API.channelDirections.create(data);
                    break;
                case 'channels':
                    // Канал добавляется к направлению
                    const directionId = data.direction_id;
                    delete data.direction_id;
                    response = await API.channelDirections.addChannel(directionId, data);
                    break;
                case 'groups':
                    response = await API.groups.create(data);
                    break;
                case 'unified_cables':
                    // Определяем тип кабеля по выбранному виду объекта
                    const objectTypeSelect = document.getElementById('modal-cable-object-type');
                    const objectTypeCode = objectTypeSelect?.options[objectTypeSelect.selectedIndex]?.dataset?.code;
                    
                    if (objectTypeCode === 'cable_ground' || objectTypeCode === 'cable_aerial') {
                        // Для кабелей с геометрией - собираем координаты
                        const coordinates = this.collectCableCoordinates();
                        if (coordinates.length < 2) {
                            this.notify('Укажите минимум 2 точки координат', 'error');
                            return;
                        }
                        data.coordinates = coordinates;
                        data.coordinate_system = 'wgs84';
                    } else if (objectTypeCode === 'cable_duct') {
                        // Для кабелей в канализации - собираем маршрут
                        const channelsSelect = document.getElementById('cable-route-channels');
                        
                        data.route_channels = Array.from(channelsSelect?.selectedOptions || []).map(o => parseInt(o.value));
                    }
                    
                    response = await API.unifiedCables.create(data);
                    break;
            }

            if (response && response.success) {
                let createdGroupId = null;
                // ТУ: загружаем выбранные вложения сразу после создания
                if (type === 'groups') {
                    const groupId = response?.data?.id || response?.data?.group_id || response?.id;
                    createdGroupId = groupId ? parseInt(groupId, 10) : null;
                    const files = Array.isArray(this._pendingGroupAttachments) ? this._pendingGroupAttachments : [];
                    if (groupId && files.length) {
                        let ok = 0;
                        let failed = 0;
                        for (const f of files) {
                            try {
                                const r = await API.groups.uploadAttachment(groupId, f, '');
                                if (r?.success) ok += 1;
                                else failed += 1;
                            } catch (e) {
                                failed += 1;
                            }
                        }
                        this._pendingGroupAttachments = [];
                        if (failed) {
                            this.notify(`Вложения: загружено ${ok}, ошибок ${failed}`, 'warning');
                        } else if (ok) {
                            this.notify(`Вложения: загружено ${ok}`, 'success');
                        }
                    }
                }

                // Режим ТУ: автоматически прикрепляем созданный объект к выбранному ТУ
                if (this.tuModeEnabled && this.tuModeGroupId && type !== 'groups') {
                    const createdId = response?.data?.id || response?.id;
                    const idNum = createdId ? parseInt(createdId, 10) : null;
                    const typeMap = {
                        wells: 'well',
                        directions: 'channel_direction',
                        markers: 'marker_post',
                        unified_cables: 'unified_cable',
                    };
                    const groupObjType = typeMap[type] || null;
                    if (idNum && groupObjType) {
                        try {
                            await API.groups.addObjects(this.tuModeGroupId, [{ type: groupObjType, id: idNum }]);
                        } catch (_) {
                            // ignore
                        }
                    }
                }
                // Кратчайший путь (duct cable): после создания кабеля остаёмся в режиме и позволяем достраивать по следующим колодцам
                try {
                    if (type === 'unified_cables') {
                        const objectTypeSelect = document.getElementById('modal-cable-object-type');
                        const objectTypeCode = objectTypeSelect?.options?.[objectTypeSelect.selectedIndex]?.dataset?.code;
                        if (
                            objectTypeCode === 'cable_duct' &&
                            MapManager?.shortestDuctCableMode &&
                            Array.isArray(this._shortestDuctCableCreateRouteChannelIds) &&
                            this._shortestDuctCableCreateRouteChannelIds.length
                        ) {
                            // По требованию: после создания кабеля очищаем состояние и выходим из режима,
                            // чтобы не подтягивались данные прошлого построения.
                            this._shortestDuctCableCreateRouteChannelIds = null;
                            this._shortestDuctCableCreateRouteDirectionIds = null;
                            this._shortestDuctCablePath = null;
                            this._prefillCableRouteChannelIds = [];
                            this._resolveShortestChannelPick = null;
                            try {
                                if (MapManager?.shortestDuctCableMode && typeof MapManager.toggleShortestDuctCableMode === 'function') {
                                    MapManager.toggleShortestDuctCableMode();
                                }
                            } catch (_) {}
                            // Снять подсветку кнопки тулбара (если режим выключили не кликом)
                            try { document.getElementById('btn-add-duct-cable-shortest-map')?.classList?.toggle('active', false); } catch (_) {}
                            this.notify('Кабель создан. Режим кратчайшего пути выключен.', 'info');
                        }
                    }
                } catch (_) {}
                this.hideModal();
                this.notify('Объект создан', 'success');
                this.loadObjects();
                MapManager.loadAllLayers();

                // Возврат в "Список карточек ТУ" после создания ТУ
                if (type === 'groups' && this._returnToTuListAfterCreate && createdGroupId) {
                    this._returnToTuListAfterCreate = false;
                    setTimeout(() => {
                        this.openTuModeModal(createdGroupId).catch(() => {});
                    }, 50);
                } else if (type === 'groups') {
                    this._returnToTuListAfterCreate = false;
                }
            } else {
                this.notify(response?.message || 'Ошибка создания', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Карта: "Набить колодец" по выбранному направлению
     */
    async openStuffWellFromDirection(directionProps) {
        // directionProps может прийти как properties GeoJSON или иной объект
        const rawId =
            (directionProps && (directionProps.id ?? directionProps.direction_id ?? directionProps.directionId)) ??
            directionProps;
        const directionId = parseInt(rawId || 0, 10);
        if (!directionId) {
            this.notify('Не удалось определить направление', 'error');
            return;
        }

        // Открываем модалку создания колодца, но в footer вызываем специальный submit
        this._stuffWellDirectionId = directionId;
        const lat = directionProps?.__clickLatLng?.lat ?? null;
        const lng = directionProps?.__clickLatLng?.lng ?? null;
        this.showAddObjectModal('wells', lat, lng);

        // Подменяем footer кнопки
        const footer = document.getElementById('modal-footer');
        if (footer) {
            footer.innerHTML = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-primary" onclick="App.submitStuffWell()">Набить колодец</button>
            `;
        }
        // Дополнительная подсказка
        this.notify('Укажите параметры нового колодца и нажмите "Набить колодец"', 'info');
    },

    async submitStuffWell() {
        const directionId = parseInt(this._stuffWellDirectionId || 0, 10);
        if (!directionId) {
            this.notify('Не выбрано направление', 'error');
            return;
        }
        const form = document.getElementById('add-object-form');
        if (form?.reportValidity && !form.reportValidity()) return;
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

        // удаляем служебное поле
        delete data.object_type_code;

        try {
            const resp = await API.channelDirections.stuffWell(directionId, data);
            if (resp?.success === false) {
                this.notify(resp.message || 'Ошибка', 'error');
                return;
            }
            this.hideModal();
            this.notify('Колодец набит', 'success');
            try { await MapManager.loadAllLayers?.(); } catch (_) {}
            try { this.loadObjects?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка набивки колодца', 'error');
        } finally {
            this._stuffWellDirectionId = null;
        }
    },

    /**
     * Карта: "Демонтаж колодца" (обратная операция к "Набить колодец")
     * Допустимо только если у колодца ровно 2 связанных направления.
     */
    async dismantleWell(wellId) {
        const id = parseInt(wellId || 0, 10);
        if (!id) return;
        if (!this.canWrite()) {
            this.notify('Недостаточно прав', 'error');
            return;
        }
        if (!confirm('Демонтировать колодец? Будут удалены 2 направления и создано 1 новое направление.')) {
            return;
        }
        try {
            const resp = await API.wells.dismantle(id);
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            this.notify('Колодец демонтирован', 'success');
            try { MapManager.hideObjectInfo?.(); } catch (_) {}
            try { await MapManager.loadAllLayers?.(); } catch (_) {}
            try { this.loadObjects?.(); } catch (_) {}
        } catch (e) {
            this.notify(e?.message || 'Ошибка демонтажа колодца', 'error');
        }
    },

    /**
     * Выгрузка объектов (CSV) с выбором разделителя
     */
    exportObjects() {
        this.showObjectsExportModal();
    },

    showCsvDelimiterModal(title, onConfirm) {
        this._pendingCsvExport = onConfirm;
        const content = `
            <div class="form-group">
                <label>Разделитель столбцов</label>
                <select id="csv-export-delimiter">
                    <option value=";">Точка с запятой ( ; )</option>
                    <option value=",">Запятая ( , )</option>
                    <option value="tab">Табуляция (TAB)</option>
                    <option value="|">Вертикальная черта ( | )</option>
                </select>
                <p class="text-muted" style="margin-top:8px;">Файл будет скачан в формате CSV с выбранным разделителем.</p>
            </div>
        `;
        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.confirmCsvDelimiter()">Выгрузить</button>
        `;
        this.showModal(title, content, footer);
    },

    async confirmCsvDelimiter() {
        const sel = document.getElementById('csv-export-delimiter');
        const delimiter = sel?.value || ';';
        const fn = this._pendingCsvExport;
        this._pendingCsvExport = null;
        this.hideModal();
        if (typeof fn !== 'function') return;
        try {
            await fn(delimiter);
            this.notify('Файл выгружен', 'success');
        } catch (e) {
            this.notify(e?.message || 'Ошибка выгрузки', 'error');
        }
    },

    showReportExportModal(type) {
        // В отчёте по инцидентам кнопки выгрузки нет по ТЗ
        if (type === 'incidents') {
            this.notify('Выгрузка для отчёта по инцидентам отключена', 'info');
            return;
        }

        this.showCsvDelimiterModal('Выгрузить отчет', (delimiter) => {
            const params = {};

            if (type === 'objects') {
                const ownerId = document.getElementById('report-objects-owner')?.value || '';
                if (ownerId) params.owner_id = ownerId;
            }
            if (type === 'contracts') {
                const contractId = document.getElementById('report-contracts-contract')?.value || '';
                if (contractId) params.contract_id = contractId;
            }
            if (type === 'inventory') {
                const ownerId = document.getElementById('report-inventory-owner')?.value || '';
                if (ownerId) params.owner_id = ownerId;
                const tagOwnerId = document.getElementById('report-inventory-tag-owner')?.value || '';
                if (tagOwnerId) params.tag_owner_id = tagOwnerId;
            }

            return API.reports.export(type, params, delimiter);
        });
    },

    showAssumedCablesExportModal() {
        const v = (typeof MapManager !== 'undefined' && MapManager?.assumedCablesVariantNo) ? MapManager.assumedCablesVariantNo : 1;
        const vv = [1, 2, 3].includes(Number(v)) ? Number(v) : 1;
        this.showCsvDelimiterModal('Выгрузить (предполагаемые кабели)', (delimiter) => {
            return API.assumedCables.export(vv, delimiter);
        });
    },

    showObjectsExportModal() {
        this.showCsvDelimiterModal('Выгрузить', (delimiter) => this.exportCurrentObjects(delimiter));
    },

    exportCurrentObjects(delimiter) {
        const search = document.getElementById('search-objects')?.value?.trim() || '';
        const params = {};
        if (search) params.search = search;
        params.delimiter = delimiter;

        switch (this.currentTab) {
            case 'wells':
                return API.download('/wells/export', params);
            case 'directions':
                return API.download('/channel-directions/export', params);
            case 'channels':
                return API.download('/cable-channels/export', params);
            case 'markers':
                return API.download('/marker-posts/export', params);
            case 'unified_cables': {
                const ot = document.getElementById('cables-filter-object-type')?.value;
                const owner = document.getElementById('cables-filter-owner')?.value;
                const contract = document.getElementById('cables-filter-contract')?.value;
                if (ot) params.object_type_id = ot;
                if (owner) params.owner_id = owner;
                if (contract) params.contract_id = contract;
                return API.download('/unified-cables/export', params);
            }
            case 'groups':
                return API.download('/groups/export', params);
            default:
                return API.download('/wells/export', params);
        }
    },

    /**
     * Показ модального окна добавления направления с предвыбранными колодцами
     */
    async showAddDirectionModalWithWells(startWell, endWell) {
        const formHtml = `
            <form id="add-object-form">
                <input type="hidden" name="start_well_id" value="${startWell.id}">
                <input type="hidden" name="end_well_id" value="${endWell.id}">
                <div class="form-group">
                    <label>Номер *</label>
                    <input type="text" name="number" required readonly style="background: var(--bg-tertiary);" value="${startWell.number}-${endWell.number}">
                </div>
                <div class="form-group">
                    <label>Начальный колодец</label>
                    <input type="text" value="${startWell.number}" disabled style="background: var(--bg-tertiary);">
                </div>
                <div class="form-group">
                    <label>Конечный колодец</label>
                    <input type="text" value="${endWell.number}" disabled style="background: var(--bg-tertiary);">
                </div>
                <div class="form-group">
                    <label>Количество каналов</label>
                    <input type="number" name="channel_count" min="1" max="16" value="1">
                </div>
                <div class="form-group">
                    <label>Собственник</label>
                    <select name="owner_id" id="modal-owner-select"></select>
                </div>
                <div class="form-group">
                    <label>Состояние</label>
                    <select name="status_id" id="modal-status-select"></select>
                </div>
                <div class="form-group">
                    <label>Длина (м)</label>
                    <input type="number" name="length_m" step="0.01" disabled style="background: var(--bg-tertiary);" placeholder="Авто-расчёт по координатам">
                </div>
                <div class="form-group">
                    <label>Примечания</label>
                    <textarea name="notes" rows="3"></textarea>
                </div>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitAddObject('directions')">Создать направление</button>
        `;

        this.showModal('Добавить направление', formHtml, footer);
        
        // Загружаем справочники
        await this.loadModalSelects('directions');
    },

    /**
     * Открыть добавление кабеля из карты с уже заданными координатами
     */
    async showAddCableModalFromMap(objectTypeCode, coordinates) {
        this.showAddObjectModal('unified_cables');

        // Даём модалке/селектам отрисоваться и загрузиться
        await new Promise(r => setTimeout(r, 150));

        // Выбираем вид объекта по коду (cable_ground / cable_aerial)
        const typeSelect = document.getElementById('modal-cable-object-type');
        if (typeSelect) {
            const opt = Array.from(typeSelect.options).find(o => o.dataset && o.dataset.code === objectTypeCode);
            if (opt) {
                typeSelect.value = opt.value;
                // важно: триггерим change, чтобы обновился префикс номера + переключились блоки формы
                typeSelect.dispatchEvent(new Event('change'));
            }
        }

        // Заполняем координаты (WGS84: lon/lat)
        const container = document.getElementById('cable-coordinates-list');
        if (container) {
            container.innerHTML = '';
            (coordinates || []).forEach(() => this.addCableCoordinate());
            const rows = container.querySelectorAll('.cable-coord-row');
            rows.forEach((row, idx) => {
                const x = row.querySelector('.coord-x');
                const y = row.querySelector('.coord-y');
                const pt = (coordinates || [])[idx];
                if (pt && x && y) {
                    x.value = pt[0];
                    y.value = pt[1];
                }
            });
        }
    },

    /**
     * Открыть добавление duct-кабеля из карты с уже выбранными каналами маршрута
     */
    async showAddDuctCableModalFromMap(channelIds) {
        this.showAddObjectModal('unified_cables');

        await new Promise(r => setTimeout(r, 200));

        const typeSelect = document.getElementById('modal-cable-object-type');
        if (typeSelect) {
            const opt = Array.from(typeSelect.options).find(o => o.dataset && o.dataset.code === 'cable_duct');
            if (opt) {
                typeSelect.value = opt.value;
                // важно: триггерим change, чтобы обновился префикс номера + переключились блоки формы
                typeSelect.dispatchEvent(new Event('change'));
            }
        }

        // Предвыбор маршрута (для режима "кратчайший путь")
        this._prefillCableRouteChannelIds = Array.isArray(channelIds)
            ? channelIds.map(v => parseInt(v, 10)).filter(v => v > 0)
            : [];

        // Загрузим опции маршрута и гарантируем, что все нужные channelId присутствуют и выбраны
        try {
            if (this._prefillCableRouteChannelIds.length) {
                await this.loadCableRouteOptions(this._prefillCableRouteChannelIds);
            } else {
                await this.loadCableRouteOptions();
            }
        } catch (_) {}
    },

    async showCablesInWell(wellId) {
        try {
            const resp = await API.unifiedCables.byWell(wellId);
            const cables = resp.data || resp || [];
            this.showCablesTableModal('Кабели в колодце', cables);
        } catch (e) {
            this.notify('Ошибка загрузки кабелей', 'error');
        }
    },

    async showCablesInDirection(directionId) {
        try {
            const resp = await API.unifiedCables.byDirection(directionId);
            const cables = resp.data || resp || [];
            this.showCablesTableModal('Кабели в направлении', cables);
        } catch (e) {
            this.notify('Ошибка загрузки кабелей', 'error');
        }
    },

    async showChannelsInDirection(directionId) {
        try {
            const resp = await API.channelDirections.get(directionId);
            const dir = resp.data || resp;
            const channels = dir.channels || [];

            const content = `
                <div style="max-height: 60vh; overflow: auto;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr>
                                <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Направление</th>
                                <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Номер канала</th>
                                <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Тип</th>
                                <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Состояние</th>
                                <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Диаметр (мм)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${channels.map(ch => `
                                <tr style="cursor:pointer;" onclick="App.showCablesForChannel(${ch.id})">
                                    <td style="padding:8px; border-bottom:1px solid var(--border-color);">${dir.number || '-'}</td>
                                    <td style="padding:8px; border-bottom:1px solid var(--border-color);">${ch.channel_number}</td>
                                    <td style="padding:8px; border-bottom:1px solid var(--border-color);">${ch.kind_name || '-'}</td>
                                    <td style="padding:8px; border-bottom:1px solid var(--border-color);">${ch.status_name || '-'}</td>
                                    <td style="padding:8px; border-bottom:1px solid var(--border-color);">${ch.diameter_mm || '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                <p class="text-muted" style="margin-top:8px;">Клик по каналу покажет кабели, использующие этот канал.</p>
            `;

            const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
            this.showModal('Каналы направления', content, footer);
        } catch (e) {
            this.notify('Ошибка загрузки каналов', 'error');
        }
    },

    async increaseDirectionChannels(directionId, currentCount = null) {
        try {
            // Если currentCount не передан — подгружаем направление
            let current = (currentCount !== null && currentCount !== undefined) ? parseInt(currentCount) : null;
            if (current === null || Number.isNaN(current)) {
                const resp = await API.channelDirections.get(directionId);
                const dir = resp.data || resp;
                current = (dir.channels || []).length;
            }

            const content = `
                <div class="form-group">
                    <label>Текущее количество каналов</label>
                    <input type="number" value="${current}" disabled style="background: var(--bg-tertiary);">
                </div>
                <div class="form-group">
                    <label>Новое количество каналов (только увеличение)</label>
                    <input type="number" id="increase-direction-target" min="${Math.min(16, current + 1)}" max="16" value="${Math.min(16, current + 1)}">
                    <p class="text-muted">Будут созданы новые каналы со значениями по умолчанию. Максимум 16.</p>
                </div>
            `;
            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-primary" onclick="App.confirmIncreaseDirectionChannels(${directionId}, ${current})">Увеличить</button>
            `;
            this.showModal('Увеличить количество каналов', content, footer);
        } catch (e) {
            this.notify('Ошибка загрузки направления', 'error');
        }
    },

    async confirmIncreaseDirectionChannels(directionId, current) {
        const input = document.getElementById('increase-direction-target');
        const target = parseInt(input?.value);
        if (!target || Number.isNaN(target)) {
            this.notify('Введите корректное количество', 'error');
            return;
        }
        if (target <= current) {
            this.notify('Можно только увеличить количество каналов', 'warning');
            return;
        }
        if (target > 16) {
            this.notify('Максимум 16 каналов', 'warning');
            return;
        }
        if (!confirm(`Увеличить количество каналов с ${current} до ${target}?`)) return;

        try {
            const resp = await API.channelDirections.ensureChannelCount(directionId, target);
            if (resp?.success === false) {
                this.notify(resp.message || 'Ошибка', 'error');
                return;
            }
            this.hideModal();
            this.notify('Каналы добавлены', 'success');
            // Обновляем слой направлений (там отображается счетчик каналов)
            if (window.MapManager && typeof window.MapManager.loadChannelDirections === 'function') {
                window.MapManager.loadChannelDirections();
            } else if (window.MapManager && typeof window.MapManager.loadAllLayers === 'function') {
                window.MapManager.loadAllLayers();
            }
        } catch (e) {
            this.notify(e.message || 'Ошибка увеличения количества каналов', 'error');
        }
    },

    async showCablesForChannel(channelId) {
        try {
            const resp = await API.unifiedCables.byChannel(channelId);
            const cables = resp.data || resp || [];
            this.showCablesTableModal('Кабели в канале', cables);
        } catch (e) {
            this.notify('Ошибка загрузки кабелей', 'error');
        }
    },

    showCablesTableModal(title, cables) {
        const content = `
            <div style="max-height: 60vh; overflow: auto;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Номер</th>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Вид объекта</th>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Тип кабеля</th>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Кабель из каталога</th>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Собственник</th>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Состояние</th>
                            <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-color);">Длина расч. (м)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(cables || []).map(c => `
                            <tr style="cursor:pointer;" onclick="MapManager.highlightCableRouteDirections(${c.id}); App.hideModal();">
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.number || '-'}</td>
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.object_type_name || '-'}</td>
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.cable_type_name || '-'}</td>
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.cable_marking || '-'}</td>
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.owner_name || '-'}</td>
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.status_name || '-'}</td>
                                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${c.length_calculated || 0}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <p class="text-muted" style="margin-top:8px;">Клик по кабелю подсветит маршрут (направления) на карте.</p>
        `;
        const footer = `<button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>`;
        this.showModal(title, content, footer);
    },

    /**
     * Обработчик смены вида объекта кабеля
     */
    onCableObjectTypeChange() {
        const select = document.getElementById('modal-cable-object-type');
        const selectedOption = select.options[select.selectedIndex];
        const objectTypeCode = selectedOption?.dataset?.code || '';
        
        const geomBlock = document.getElementById('cable-geometry-block');
        const routeBlock = document.getElementById('cable-route-block');

        // Персональный дефолт типа кабеля зависит от выбранного вида объекта кабеля (cable_ground/cable_aerial/cable_duct)
        // Ключ настроек: default_ref_<object_type_code> (fallback: default_cable_type_id)
        try {
            const cableTypeSelect = document.getElementById('modal-cable-type-select');
            if (cableTypeSelect && !cableTypeSelect.dataset?.value) {
                const refKey = objectTypeCode ? `default_ref_${String(objectTypeCode)}` : '';
                const udef = (refKey && this.settings?.[refKey]) ? String(this.settings?.[refKey]) : String(this.settings?.default_cable_type_id || '');
                if (udef) {
                    const exists = Array.from(cableTypeSelect.options).some(o => String(o.value) === String(udef));
                    if (exists) {
                        cableTypeSelect.value = String(udef);
                        this.onCableTypeChange().catch(() => {});
                    }
                }
            }
        } catch (_) {}
        
        if (objectTypeCode === 'cable_duct') {
            // Кабель в канализации - показываем маршрут
            geomBlock.style.display = 'none';
            routeBlock.style.display = 'block';
            // Если маршрут был передан извне (кратчайший путь) — предвыбираем
            const ids = Array.isArray(this._prefillCableRouteChannelIds) ? this._prefillCableRouteChannelIds : [];
            if (ids && ids.length) this.loadCableRouteOptions(ids).catch(() => {});
            else this.loadCableRouteOptions().catch(() => {});
        } else if (objectTypeCode === 'cable_ground' || objectTypeCode === 'cable_aerial') {
            // Кабель в грунте или воздушный - показываем координаты
            geomBlock.style.display = 'block';
            routeBlock.style.display = 'none';
            // Добавляем начальные 2 точки
            const coordsList = document.getElementById('cable-coordinates-list');
            if (coordsList && coordsList.children.length === 0) {
                this.addCableCoordinate();
                this.addCableCoordinate();
            }
        } else {
            geomBlock.style.display = 'none';
            routeBlock.style.display = 'none';
        }
    },

    /**
     * Обработчик смены типа кабеля
     */
    async onCableTypeChange() {
        const cableTypeId = document.getElementById('modal-cable-type-select')?.value;
        const catalogSelect = document.getElementById('modal-cable-catalog-select');
        
        if (!catalogSelect) return;
        
        catalogSelect.innerHTML = '<option value="">Загрузка...</option>';
        
        try {
            const response = await API.references.all('cable_catalog');
            if (response.success) {
                const filteredCables = cableTypeId 
                    ? response.data.filter(c => c.cable_type_id == cableTypeId)
                    : response.data;
                
                catalogSelect.innerHTML = '<option value="">Выберите марку кабеля...</option>' +
                    filteredCables.map(c => `<option value="${c.id}" data-is-default="${c.is_default ? 1 : 0}">${c.marking} (${c.fiber_count} жил)</option>`).join('');

                // Персональный дефолт каталога кабелей (если это новая запись)
                const udef = this.settings?.default_cable_catalog_id || '';
                if (udef && !catalogSelect.dataset?.value && !catalogSelect.value) {
                    const exists = (filteredCables || []).some(c => String(c.id) === String(udef));
                    if (exists) {
                        catalogSelect.value = String(udef);
                        return;
                    }
                }

                // Автовыбор значения по умолчанию из справочника (если ничего не выбрано / новая запись)
                if (!catalogSelect.value) {
                    const def = (filteredCables || []).find(c => c.is_default);
                    if (def) catalogSelect.value = String(def.id);
                }
            }
        } catch (error) {
            catalogSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    },

    /**
     * Добавление точки координат кабеля
     */
    addCableCoordinate() {
        const container = document.getElementById('cable-coordinates-list');
        if (!container) return;
        
        const index = container.children.length;
        const div = document.createElement('div');
        div.className = 'cable-coord-row';
        div.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px; align-items: center;';
        div.innerHTML = `
            <span style="min-width: 30px;">${index + 1}.</span>
            <input type="number" step="0.000001" placeholder="Долгота/X" class="coord-x" style="flex: 1;">
            <input type="number" step="0.000001" placeholder="Широта/Y" class="coord-y" style="flex: 1;">
            <button type="button" class="btn btn-sm btn-danger" onclick="this.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        `;
        container.appendChild(div);
    },

    /**
     * Загрузка опций для маршрута кабеля в канализации
     */
    async loadCableRouteOptions(requiredIds = null) {
        try {
            const channelsResponse = await API.cableChannels.list({ limit: 1000 });
            const channelsSelect = document.getElementById('cable-route-channels');
            
            if (channelsSelect && channelsResponse.success !== false) {
                const required = Array.isArray(requiredIds)
                    ? requiredIds.map(v => parseInt(v, 10)).filter(v => v > 0)
                    : [];
                // сохраняем текущий выбор, если это просто перезагрузка списка
                const prevSelected = new Set(Array.from(channelsSelect.selectedOptions || []).map(o => String(o.value)));
                const channels = channelsResponse.data || channelsResponse;
                channelsSelect.innerHTML = channels.map(c => 
                    `<option value="${c.id}">Канал ${c.channel_number} (${c.direction_number || '-'})</option>`
                ).join('');

                // Если некоторые каналы маршрута не попали в limit (1000) — подтянем точечно
                if (required.length) {
                    const existing = new Set(Array.from(channelsSelect.options).map(o => parseInt(o.value, 10)));
                    for (const id of required) {
                        if (existing.has(id)) continue;
                        try {
                            const r = await API.cableChannels.get(id);
                            const ch = r?.data || r;
                            if (ch && ch.id) {
                                const opt = document.createElement('option');
                                opt.value = String(ch.id);
                                opt.textContent = `Канал ${ch.channel_number || '-'} (${ch.direction_number || ch.direction_id || '-'})`;
                                channelsSelect.appendChild(opt);
                                existing.add(parseInt(ch.id, 10));
                            }
                        } catch (_) {
                            // ignore missing
                        }
                    }
                }

                // Восстанавливаем выбор:
                // - если задан requiredIds — выбираем их (для кратчайшего пути/редактирования)
                // - иначе возвращаем предыдущий выбор
                if (required.length) {
                    const set = new Set(required.map(v => String(v)));
                    Array.from(channelsSelect.options).forEach(o => { o.selected = set.has(String(o.value)); });
                } else if (prevSelected.size) {
                    Array.from(channelsSelect.options).forEach(o => { o.selected = prevSelected.has(String(o.value)); });
                }
            }
        } catch (error) {
            console.error('Ошибка загрузки опций маршрута:', error);
        }
    },

    /**
     * Сбор координат из формы кабеля
     */
    collectCableCoordinates() {
        const container = document.getElementById('cable-coordinates-list');
        if (!container) return [];
        
        const coords = [];
        container.querySelectorAll('.cable-coord-row').forEach(row => {
            const x = row.querySelector('.coord-x')?.value;
            const y = row.querySelector('.coord-y')?.value;
            if (x && y) {
                coords.push([parseFloat(x), parseFloat(y)]);
            }
        });
        return coords;
    },

    /**
     * Модальное окно "Загрузить" (импорт колодцев из текста)
     */
    showImportModal() {
        if (this.currentTab !== 'wells') {
            this.notify('Загрузка доступна только для объекта "Колодцы"', 'info');
            return;
        }
        if (!this.canWrite()) {
            this.notify('Недостаточно прав для загрузки', 'error');
            return;
        }

        const content = `
            <div style="display:grid; gap: 12px;">
                <div style="display:flex; gap: 10px; flex-wrap: wrap; align-items: end;">
                    <div class="form-group" style="min-width: 220px;">
                        <label>Система координат</label>
                        <select id="well-import-coord-system" disabled>
                            <option value="wgs84" selected>WGS84 (longitude/latitude)</option>
                        </select>
                    </div>
                    <div class="form-group" style="min-width: 220px;">
                        <label>Разделитель</label>
                        <select id="well-import-delimiter">
                            <option value=";" selected>;</option>
                            <option value=",">,</option>
                            <option value="tab">TAB</option>
                            <option value="|">|</option>
                        </select>
                    </div>
                    <div class="form-group" style="min-width: 260px;">
                        <label>Собственник *</label>
                        <select id="well-import-owner"></select>
                    </div>
                    <div class="form-group" style="min-width: 240px;">
                        <label>Тип *</label>
                        <select id="well-import-kind"></select>
                    </div>
                    <div class="form-group" style="min-width: 240px;">
                        <label>Состояние *</label>
                        <select id="well-import-status"></select>
                    </div>
                    <div class="form-group" style="flex: 1;">
                        <button class="btn btn-secondary" type="button" onclick="App.previewWellTextImport()">
                            <i class="fas fa-eye"></i> Предпросмотр
                        </button>
                    </div>
                </div>

                <div class="form-group">
                    <label>Данные (многострочный текст)</label>
                    <textarea id="well-import-text" rows="10" placeholder="Вставьте строки. Каждая строка — 1 колодец."></textarea>
                    <p class="text-muted" style="margin-top:6px;">
                        Ниже появится предпросмотр и сопоставление колонок полям. Поле "Система координат" отдельно — вверху (по умолчанию WGS84).
                    </p>
                </div>

                <div id="well-import-preview" class="hidden"></div>
                <div id="well-import-mapping" class="hidden"></div>
                <div id="well-import-result" class="hidden"></div>
            </div>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.executeWellTextImport()">Загрузить</button>
        `;

        this.showModal('Загрузить: колодцы', content, footer);

        // Загружаем справочники (owner/kind/status) как в форме "Добавить колодец"
        this.loadWellImportSelects().catch(() => {});

        // Автопредпросмотр с задержкой
        setTimeout(() => {
            const ta = document.getElementById('well-import-text');
            const del = document.getElementById('well-import-delimiter');
            const owner = document.getElementById('well-import-owner');
            const kind = document.getElementById('well-import-kind');
            const status = document.getElementById('well-import-status');
            const handler = () => this.scheduleWellImportPreview();
            ta?.addEventListener('input', handler);
            del?.addEventListener('change', handler);
            owner?.addEventListener('change', handler);
            kind?.addEventListener('change', handler);
            status?.addEventListener('change', handler);
        }, 0);
    },

    async loadWellImportSelects() {
        const ownerSelect = document.getElementById('well-import-owner');
        const kindSelect = document.getElementById('well-import-kind');
        const statusSelect = document.getElementById('well-import-status');
        if (!ownerSelect || !kindSelect || !statusSelect) return;

        ownerSelect.innerHTML = '<option value="">Загрузка...</option>';
        kindSelect.innerHTML = '<option value="">Загрузка...</option>';
        statusSelect.innerHTML = '<option value="">Загрузка...</option>';

        try {
            const [owners, types, kinds, statuses] = await Promise.all([
                API.references.all('owners'),
                API.references.all('object_types'),
                API.references.all('object_kinds'),
                API.references.all('object_status'),
            ]);

            const ownersData = owners?.data || [];
            ownerSelect.innerHTML = '<option value="">Выберите...</option>' +
                ownersData.map(o => `<option value="${o.id}" data-code="${o.code || ''}" data-is-default="${o.is_default ? 1 : 0}">${o.name}</option>`).join('');
            const ownerDefault = ownersData.find(o => o.is_default);
            if (ownerDefault) ownerSelect.value = String(ownerDefault.id);

            // type_id для колодцев определяется системным кодом "well"
            const typesData = types?.data || [];
            const wellType = typesData.find(t => t.code === 'well');
            this._wellImportTypeId = wellType?.id || null;

            const kindsData = kinds?.data || [];
            const filteredKinds = this._wellImportTypeId
                ? kindsData.filter(k => String(k.object_type_id) === String(this._wellImportTypeId))
                : kindsData;

            kindSelect.innerHTML = '<option value="">Выберите...</option>' +
                filteredKinds.map(k => `<option value="${k.id}" data-is-default="${k.is_default ? 1 : 0}">${k.name}</option>`).join('');
            const kindDefault = filteredKinds.find(k => k.is_default);
            if (kindDefault) kindSelect.value = String(kindDefault.id);

            const statusData = statuses?.data || [];
            statusSelect.innerHTML = '<option value="">Выберите...</option>' +
                statusData.map(s => `<option value="${s.id}" data-is-default="${s.is_default ? 1 : 0}">${s.name}</option>`).join('');
            const statusDefault = statusData.find(s => s.is_default);
            if (statusDefault) statusSelect.value = String(statusDefault.id);
        } catch (e) {
            ownerSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
            kindSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
            statusSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    },

    /**
     * Debounce предпросмотра
     */
    scheduleWellImportPreview() {
        clearTimeout(this._wellImportPreviewTimer);
        this._wellImportPreviewTimer = setTimeout(() => this.previewWellTextImport(), 300);
    },

    async previewWellTextImport() {
        const text = document.getElementById('well-import-text')?.value || '';
        const delimiter = document.getElementById('well-import-delimiter')?.value || ';';

        const previewEl = document.getElementById('well-import-preview');
        const mappingEl = document.getElementById('well-import-mapping');
        const resultEl = document.getElementById('well-import-result');
        if (resultEl) resultEl.classList.add('hidden');

        if (!previewEl || !mappingEl) return;
        if (!text.trim()) {
            previewEl.classList.add('hidden');
            mappingEl.classList.add('hidden');
            return;
        }

        try {
            const resp = await API.wells.importTextPreview(text, delimiter);
            if (!resp?.success) {
                this.notify(resp?.message || 'Ошибка предпросмотра', 'error');
                return;
            }

            const data = resp.data || {};
            const rows = data.preview || [];
            const maxCols = data.max_columns || 0;
            const total = data.total_lines || 0;
            const fields = ['number', 'latitude', 'longitude'];

            const fieldLabels = {
                number: 'Номер',
                latitude: 'Широта',
                longitude: 'Долгота',
            };

            this._wellImportMaxCols = maxCols;
            this._wellImportFields = fields;
            this._wellImportTotalLines = total;

            previewEl.classList.remove('hidden');
            previewEl.innerHTML = `
                <div style="margin-top: 6px;">
                    <strong>Предпросмотр:</strong>
                    <span class="text-muted">(строк: ${total}, колонок (макс): ${maxCols})</span>
                </div>
                <div style="max-height: 220px; overflow:auto; border: 1px solid var(--border-color); border-radius: 8px; margin-top: 8px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr>
                                ${Array.from({ length: maxCols }).map((_, i) => `<th style="text-align:left; padding:6px 8px; border-bottom:1px solid var(--border-color);">#${i + 1}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((r, idx) => `
                                <tr>
                                    ${Array.from({ length: maxCols }).map((_, i) => `<td style="padding:6px 8px; border-bottom:1px solid var(--border-color);">${this.escapeHtml(r?.[i] ?? '')}</td>`).join('')}
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;

            mappingEl.classList.remove('hidden');
            mappingEl.innerHTML = `
                <div style="margin-top: 10px;">
                    <strong>Сопоставление колонок</strong>
                    <p class="text-muted" style="margin-top:6px;">Выберите, какая колонка соответствует какому полю (можно не использовать колонку).</p>
                </div>
                <div style="display:grid; gap: 8px;">
                    ${Array.from({ length: maxCols }).map((_, i) => `
                        <div style="display:flex; gap: 10px; align-items:center;">
                            <div style="min-width: 90px;"><strong>#${i + 1}</strong></div>
                            <select id="well-import-map-${i}" style="flex: 1;">
                                <option value="ignore">Не использовать</option>
                                ${fields.map(f => `<option value="${f}">${fieldLabels[f] || f}</option>`).join('')}
                            </select>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (e) {
            this.notify(e?.message || 'Ошибка предпросмотра', 'error');
        }
    },

    collectWellImportMapping() {
        const maxCols = this._wellImportMaxCols || 0;
        const mapping = {};
        const used = new Map();
        for (let i = 0; i < maxCols; i++) {
            const val = document.getElementById(`well-import-map-${i}`)?.value || 'ignore';
            if (!val || val === 'ignore') continue;
            if (used.has(val)) {
                throw new Error(`Поле "${val}" выбрано более одного раза (колонки #${used.get(val) + 1} и #${i + 1})`);
            }
            used.set(val, i);
            mapping[i] = val;
        }
        return mapping;
    },

    async executeWellTextImport() {
        const text = document.getElementById('well-import-text')?.value || '';
        const delimiter = document.getElementById('well-import-delimiter')?.value || ';';
        const coordSystem = 'wgs84';
        const resultEl = document.getElementById('well-import-result');
        const ownerId = document.getElementById('well-import-owner')?.value || '';
        const kindId = document.getElementById('well-import-kind')?.value || '';
        const statusId = document.getElementById('well-import-status')?.value || '';

        if (!text.trim()) {
            this.notify('Вставьте данные для загрузки', 'warning');
            return;
        }

        if (!ownerId || !kindId || !statusId) {
            this.notify('Выберите Собственник, Тип и Состояние', 'warning');
            return;
        }

        let mapping;
        try {
            mapping = this.collectWellImportMapping();
        } catch (e) {
            this.notify(e?.message || 'Ошибка сопоставления колонок', 'error');
            return;
        }

        try {
            const resp = await API.wells.importText(text, delimiter, mapping, coordSystem, {
                default_owner_id: parseInt(ownerId),
                default_kind_id: parseInt(kindId),
                default_status_id: parseInt(statusId),
            });
            if (!resp?.success) {
                this.notify(resp?.message || 'Ошибка загрузки', 'error');
                return;
            }

            const data = resp.data || {};
            const imported = data.imported || 0;
            const errors = data.errors || [];

            if (resultEl) {
                resultEl.classList.remove('hidden');
                resultEl.innerHTML = `
                    <div style="margin-top: 10px;">
                        <strong>Результат:</strong> импортировано <strong>${imported}</strong>
                    </div>
                    ${errors.length ? `
                        <div style="margin-top: 8px;">
                            <strong>Ошибки (${errors.length}):</strong>
                            <div style="max-height: 180px; overflow:auto; border: 1px solid var(--border-color); border-radius: 8px; padding: 8px; margin-top: 6px;">
                                ${errors.slice(0, 200).map(e => `<div class="text-muted">Строка ${e.line}: ${this.escapeHtml(e.error)}</div>`).join('')}
                                ${errors.length > 200 ? `<div class="text-muted">... и ещё ${errors.length - 200}</div>` : ''}
                            </div>
                        </div>
                    ` : '<div class="text-muted" style="margin-top:8px;">Ошибок нет.</div>'}
                `;
            }

            this.notify(`Загрузка завершена: ${imported}`, 'success');
            this.loadObjects();
            MapManager.loadAllLayers();
        } catch (e) {
            this.notify(e?.message || 'Ошибка загрузки', 'error');
        }
    },

    /**
     * Редактирование текущего объекта (из панели информации)
     */
    editCurrentObject() {
        const panel = document.getElementById('object-info-panel');
        const rawType = panel.dataset.objectType;
        const id = panel.dataset.objectId;

        // Приводим типы объектов карты к типам вкладок/модалок приложения
        const typeMap = {
            well: 'wells',
            channel_direction: 'directions',
            marker_post: 'markers',
            unified_cable: 'unified_cables',
        };
        const type = typeMap[rawType] || rawType;
        
        if (type && id) {
            this.showEditObjectModal(type, id);
        }
    },

    /**
     * Удаление текущего объекта
     */
    async deleteCurrentObject() {
        const panel = document.getElementById('object-info-panel');
        const type = panel.dataset.objectType;
        const id = panel.dataset.objectId;
        
        if (!confirm('Вы уверены, что хотите удалить этот объект?')) {
            return;
        }

        try {
            let response;
            
            switch (type) {
                case 'well':
                    response = await API.wells.delete(id);
                    break;
                case 'channel_direction':
                    response = await API.channelDirections.delete(id);
                    break;
                case 'marker_post':
                    response = await API.markerPosts.delete(id);
                    break;
                case 'unified_cable':
                    response = await API.unifiedCables.delete(id);
                    break;
                default:
                    if (type.endsWith('_cable')) {
                        const cableType = type.replace('_cable', '');
                        response = await API.cables.delete(cableType, id);
                    }
            }

            if (response && response.success) {
                MapManager.hideObjectInfo();
                MapManager.loadAllLayers();
                this.notify('Объект удалён', 'success');
            } else {
                this.notify(response?.message || 'Ошибка удаления', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Показ модального окна добавления инцидента
     */
    showAddIncidentModal() {
        this.incidentDraftRelatedObjects = [];
        const content = `
            <form id="incident-form">
                <div class="form-group">
                    <label>Номер *</label>
                    <input type="text" name="number" required>
                </div>
                <div class="form-group">
                    <label>Заголовок *</label>
                    <input type="text" name="title" required>
                </div>
                <div class="form-group">
                    <label>Дата инцидента *</label>
                    <input type="datetime-local" name="incident_date" required>
                </div>
                <div class="form-group">
                    <label>Приоритет</label>
                    <select name="priority">
                        <option value="low">Низкий</option>
                        <option value="normal" selected>Обычный</option>
                        <option value="high">Высокий</option>
                        <option value="critical">Критический</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Статус</label>
                    <select name="status">
                        <option value="open" selected>Открыт</option>
                        <option value="in_progress">В работе</option>
                        <option value="resolved">Решён</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="4"></textarea>
                </div>
                <div class="form-group">
                    <label>Виновник</label>
                    <input type="text" name="culprit">
                </div>
                <hr>
                <h4>Связанные объекты</h4>
                <div id="incident-related-objects" class="text-muted">Нет объектов</div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="App.startIncidentSelectFromCreate()" style="margin-top: 8px;">
                    <i class="fas fa-crosshairs"></i> Указать объект на карте
                </button>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitIncident()">Создать</button>
        `;

        this.showModal('Создать инцидент', content, footer);
        this.renderIncidentRelatedObjects();
    },

    startIncidentSelectFromCreate() {
        const form = document.getElementById('incident-form');
        const draft = form ? Object.fromEntries(new FormData(form).entries()) : {};
        this._incidentCreatePick = { draft, related: [...(this.incidentDraftRelatedObjects || [])] };
        this.hideModal();
        this.switchPanel('map');
        MapManager.startIncidentSelectMode();
    },

    /**
     * Отправка формы инцидента
     */
    async submitIncident() {
        const form = document.getElementById('incident-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        data.related_objects = this.incidentDraftRelatedObjects;

        try {
            const response = await API.incidents.create(data);
            if (response.success) {
                this.hideModal();
                this.notify('Инцидент создан', 'success');
                this.loadIncidents();
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    getIncidentObjectTypeName(type) {
        const names = {
            well: 'Колодец',
            channel_direction: 'Направление',
            cable_channel: 'Канал',
            unified_cable: 'Кабель',
            ground_cable: 'Кабель в грунте',
            aerial_cable: 'Воздушный кабель',
            duct_cable: 'Кабель в канализации',
            marker_post: 'Столбик',
        };
        return names[type] || type;
    },

    addIncidentRelatedObjectFromMap(hit) {
        // Возвращаем курсор
        try {
            const c = MapManager.map?.getContainer?.();
            if (c) c.style.cursor = '';
        } catch (e) {}

        const t = hit?.objectType;
        const p = hit?.properties || {};
        if (!t || !p?.id) return;

        // map objectType -> incident type
        let type = t;
        if (t === 'unified_cable') type = 'unified_cable';
        if (t === 'well') type = 'well';
        if (t === 'channel_direction') type = 'channel_direction';
        if (t === 'marker_post') type = 'marker_post';

        const exists = this.incidentDraftRelatedObjects.some(o => o.type === type && String(o.id) === String(p.id));
        if (!exists) {
            this.incidentDraftRelatedObjects.push({ type, id: parseInt(p.id), number: p.number || null });
            this.notify(`Добавлен объект: ${this.getIncidentObjectTypeName(type)} ${p.number || p.id}`, 'success');
        }
        this.renderIncidentRelatedObjects();

        // Если выбирали объект из режима создания инцидента — возвращаемся в модалку
        if (this._incidentCreatePick) {
            const pick = this._incidentCreatePick;
            pick.related = [...this.incidentDraftRelatedObjects];
            this.showAddIncidentModal();
            const f = document.getElementById('incident-form');
            if (f) {
                Object.entries(pick.draft || {}).forEach(([k, v]) => {
                    const el = f.querySelector(`[name="${k}"]`);
                    if (el) el.value = v;
                });
            }
            this.incidentDraftRelatedObjects = pick.related || [];
            this.renderIncidentRelatedObjects();
            this._incidentCreatePick = null;
            return;
        }

        // Если выбирали объект из режима редактирования инцидента — возвращаемся в модалку
        if (this._incidentEditPick?.id) {
            const pick = this._incidentEditPick;
            pick.related = [...this.incidentDraftRelatedObjects];
            (async () => {
                try {
                    const resp = await API.incidents.get(pick.id);
                    if (!resp?.success) return;
                    this.showEditIncidentModal(resp.data);

                    // восстанавливаем draft полей формы
                    const f = document.getElementById('incident-edit-form');
                    if (f) {
                        Object.entries(pick.draft || {}).forEach(([k, v]) => {
                            const el = f.querySelector(`[name="${k}"]`);
                            if (el) el.value = v;
                        });
                    }
                    this.incidentDraftRelatedObjects = pick.related || [];
                    this.renderIncidentRelatedObjects();
                } finally {
                    this._incidentEditPick = null;
                }
            })();
        }
    },

    renderIncidentRelatedObjects() {
        const container = document.getElementById('incident-related-objects');
        if (!container) return;
        const list = this.incidentDraftRelatedObjects || [];
        if (!list.length) {
            container.innerHTML = '<div class="text-muted">Нет объектов</div>';
            return;
        }
        container.innerHTML = `
            <div style="display:grid; gap:6px;">
                ${list.map((o, idx) => `
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; border:1px solid var(--border-color); border-radius:6px;">
                        <span>${this.getIncidentObjectTypeName(o.type)}: ${o.number || ('#' + o.id)}</span>
                        <button type="button" class="btn btn-sm btn-danger" onclick="App.removeIncidentRelatedObject(${idx})">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    },

    removeIncidentRelatedObject(idx) {
        this.incidentDraftRelatedObjects.splice(idx, 1);
        this.renderIncidentRelatedObjects();
    },

    /**
     * Показ модального окна добавления пользователя
     */
    showAddUserModal() {
        const content = `
            <form id="user-form">
                <div class="form-group">
                    <label>Логин * (3–100 символов, уникальный)</label>
                    <input type="text" name="login" required minlength="3" maxlength="100" autocomplete="username">
                </div>
                <div class="form-group">
                    <label>Пароль * (мин. 6 символов)</label>
                    <input type="password" name="password" required minlength="6" autocomplete="new-password">
                </div>
                <div class="form-group">
                    <label>Полное имя</label>
                    <input type="text" name="full_name">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" name="email" placeholder="name@example.com">
                </div>
                <div class="form-group">
                    <label>Роль * (обязательно)</label>
                    <select name="role_id" required id="user-role-select"></select>
                </div>
                <div class="form-group" id="user-owner-group" style="display:none;">
                    <label>Собственник (только для роли "Только чтение")</label>
                    <select name="owner_id" id="user-owner-select" disabled></select>
                    <p class="text-muted">На карте будут видны только кабели этого собственника.</p>
                </div>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitUser()">Создать</button>
        `;

        this.showModal('Добавить пользователя', content, footer);
        this.loadRolesSelect().then(() => {
            this.bindReadonlyOwnerToUserRoleSelect('user-role-select', 'user-owner-group', 'user-owner-select');
        });
        this.loadOwnersSelect('user-owner-select');
    },

    /**
     * Загрузка ролей в селект
     */
    async loadRolesSelect(selectId = 'user-role-select', selectedRoleCode = null) {
        try {
            const response = await API.users.roles();
            if (response.success) {
                const select = document.getElementById(selectId);
                if (!select) return;
                select.innerHTML = response.data
                    .map(r => `<option value="${r.id}" data-code="${this.escapeHtml(r.code)}" ${selectedRoleCode && r.code === selectedRoleCode ? 'selected' : ''}>${this.escapeHtml(r.name)}</option>`)
                    .join('');
            }
        } catch (error) {
            console.error('Ошибка загрузки ролей:', error);
        }
    },

    async loadOwnersSelect(selectId, selectedOwnerId = null) {
        try {
            const resp = await API.references.all('owners');
            if (resp?.success === false) throw new Error(resp?.message || 'Ошибка');
            const list = resp?.data || resp || [];
            const select = document.getElementById(selectId);
            if (!select) return;

            const options = [
                `<option value="">— выберите —</option>`,
                ...(Array.isArray(list) ? list : []).map(o => {
                    const id = o.id;
                    const name = this.escapeHtml(o.name || '');
                    const code = this.escapeHtml(o.code || '');
                    const label = code ? `${name} (${code})` : name;
                    return `<option value="${id}">${label}</option>`;
                }),
            ];
            select.innerHTML = options.join('');

            if (selectedOwnerId !== null && selectedOwnerId !== undefined && String(selectedOwnerId) !== '') {
                select.value = String(selectedOwnerId);
            }
        } catch (error) {
            console.error('Ошибка загрузки собственников:', error);
        }
    },

    bindReadonlyOwnerToUserRoleSelect(roleSelectId, ownerGroupId, ownerSelectId) {
        const roleSel = document.getElementById(roleSelectId);
        const group = document.getElementById(ownerGroupId);
        const ownerSel = document.getElementById(ownerSelectId);
        if (!roleSel || !group || !ownerSel) return;

        const update = () => {
            const opt = roleSel.options?.[roleSel.selectedIndex];
            const code = (opt?.dataset?.code || '').toString();
            const isReadonly = code === 'readonly';
            group.style.display = isReadonly ? '' : 'none';
            ownerSel.disabled = !isReadonly;
            ownerSel.required = isReadonly;
            if (!isReadonly) ownerSel.value = '';
        };

        if (!roleSel._igsReadonlyOwnerBound) {
            roleSel._igsReadonlyOwnerBound = true;
            roleSel.addEventListener('change', update);
        }
        update();
    },

    /**
     * Отправка формы пользователя
     */
    async submitUser() {
        const form = document.getElementById('user-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        if (data.role_id !== undefined) data.role_id = parseInt(data.role_id, 10);
        if (!data.owner_id) {
            delete data.owner_id;
        } else {
            data.owner_id = parseInt(data.owner_id, 10);
        }

        try {
            const response = await API.auth.register(data);
            if (response.success) {
                this.hideModal();
                this.notify('Пользователь создан', 'success');
                this.loadUsers();
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Получить форму для справочника по типу
     */
    getReferenceForm(type, data = {}) {
        const defaultBlock = `
            <div class="form-group" style="margin-top: 8px;">
                <label style="display:flex; align-items:center; gap:8px;">
                    <input type="checkbox" name="is_default" ${data.is_default ? 'checked' : ''}>
                    По умолчанию
                </label>
                <p class="text-muted">Можно выбрать только одно значение по умолчанию в справочнике (для "Типов" — в рамках "Вида объекта").</p>
            </div>
        `;

        const forms = {
            'object_types': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required ${data.id ? 'disabled style="background: var(--bg-tertiary);"' : ''}>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="2">${data.description || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Справочная таблица</label>
                    <select name="reference_table">
                        <option value="" ${!data.reference_table ? 'selected' : ''}>(не указано)</option>
                        <option value="object_kinds" ${(data.reference_table === 'object_kinds') ? 'selected' : ''}>Типы объектов</option>
                        <option value="cable_types" ${(data.reference_table === 'cable_types') ? 'selected' : ''}>Типы кабелей</option>
                        <option value="cable_catalog" ${(data.reference_table === 'cable_catalog') ? 'selected' : ''}>Каталог кабелей</option>
                    </select>
                    <p class="text-muted">Определяет, из какого справочника брать варианты "типа" для данного вида объектов (используется в "Настройки по умолчанию" на карте).</p>
                </div>
                <div class="form-group">
                    <label>Код номера</label>
                    <input type="text" name="number_code" value="${data.number_code || data.code || ''}" maxlength="50" placeholder="Например: ККС, СТ, КАБ...">
                    <p class="text-muted">Используется в формировании номера: &lt;Код номера&gt;-&lt;Код собственника&gt;-&lt;число&gt;(-суффикс).</p>
                </div>
                <div class="form-group">
                    <label>Иконка</label>
                    <input type="text" name="icon" value="${data.icon || ''}" placeholder="circle, line, marker...">
                    <p class="text-muted">Иконки: Font Awesome 6 (solid). Примеры: map-marker-alt, project-diagram, wave-square, broadcast-tower, route, tag.</p>
                </div>
                <div class="form-group">
                    <label>Цвет</label>
                    <input type="color" name="color" value="${data.color || '#3498db'}">
                </div>
            `,
            'object_kinds': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Вид объекта</label>
                    <select name="object_type_id" id="ref-object-type-select" data-value="${data.object_type_id || ''}"></select>
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="2">${data.description || ''}</textarea>
                </div>
                ${defaultBlock}
            `,
            'object_status': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Цвет</label>
                    <input type="color" name="color" value="${data.color || '#27ae60'}">
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="2">${data.description || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Порядок сортировки</label>
                    <input type="number" name="sort_order" value="${data.sort_order || 0}">
                </div>
                ${defaultBlock}
            `,
            'owners': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required ${data.id ? 'readonly style="background: var(--bg-tertiary);"' : ''}>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Краткое название</label>
                    <input type="text" name="short_name" value="${data.short_name || ''}">
                </div>
                <div class="form-group">
                    <label>Цвет</label>
                    <input type="color" name="color" value="${data.color || '#3b82f6'}">
                </div>
                <div class="form-group">
                    <label>ИНН</label>
                    <input type="text" name="inn" value="${data.inn || ''}">
                </div>
                <div class="form-group">
                    <label>Адрес</label>
                    <input type="text" name="address" value="${data.address || ''}">
                </div>
                <div class="form-group">
                    <label>Контактное лицо</label>
                    <input type="text" name="contact_person" value="${data.contact_person || ''}">
                </div>
                <div class="form-group">
                    <label>Телефон</label>
                    <input type="text" name="contact_phone" value="${data.contact_phone || ''}">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" name="contact_email" value="${data.contact_email || ''}">
                </div>
                <div class="form-group">
                    <label>Примечания</label>
                    <textarea name="notes" rows="2">${data.notes || ''}</textarea>
                </div>
                ${defaultBlock}
            `,
            'contracts': `
                <div class="form-group">
                    <label>Номер *</label>
                    <input type="text" name="number" value="${data.number || ''}" required>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Арендатор</label>
                    <select name="owner_id" id="ref-owner-select" data-value="${data.owner_id || ''}"></select>
                </div>
                <div class="form-group">
                    <label>Арендодатель</label>
                    <select name="landlord_id" id="ref-landlord-select" data-value="${data.landlord_id || ''}"></select>
                </div>
                <div class="form-group">
                    <label>Дата начала</label>
                    <input type="date" name="start_date" value="${data.start_date || ''}">
                </div>
                <div class="form-group">
                    <label>Дата окончания</label>
                    <input type="date" name="end_date" value="${data.end_date || ''}">
                </div>
                <div class="form-group">
                    <label>Статус</label>
                    <select name="status">
                        <option value="active" ${data.status === 'active' ? 'selected' : ''}>Активный</option>
                        <option value="inactive" ${data.status === 'inactive' ? 'selected' : ''}>Неактивный</option>
                        <option value="expired" ${data.status === 'expired' ? 'selected' : ''}>Истёк</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Сумма</label>
                    <input type="number" name="amount" step="0.01" value="${data.amount || ''}">
                </div>
                <div class="form-group">
                    <label>Примечания</label>
                    <textarea name="notes" rows="2">${data.notes || ''}</textarea>
                </div>
                ${defaultBlock}
            `,
            'cable_types': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="2">${data.description || ''}</textarea>
                </div>
                ${defaultBlock}
            `,
            'cable_catalog': `
                <div class="form-group">
                    <label>Тип кабеля *</label>
                    <select name="cable_type_id" id="ref-cable-type-select" data-value="${data.cable_type_id || ''}" required></select>
                </div>
                <div class="form-group">
                    <label>Маркировка *</label>
                    <input type="text" name="marking" value="${data.marking || ''}" required>
                </div>
                <div class="form-group">
                    <label>Количество волокон</label>
                    <input type="number" name="fiber_count" value="${data.fiber_count || ''}">
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="2">${data.description || ''}</textarea>
                </div>
                ${defaultBlock}
            `,
        };
        
        return forms[type] || forms['object_types'];
    },

    /**
     * Показ модального окна добавления записи справочника
     */
    showAddReferenceModal() {
        const formHtml = this.getReferenceForm(this.currentReference);
        
        const content = `<form id="ref-form">${formHtml}</form>`;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitReference()">Создать</button>
        `;

        this.showModal('Добавить запись', content, footer);
        
        // Загружаем связанные справочники
        this.loadReferenceFormSelects();
    },

    /**
     * Редактирование записи справочника
     */
    async editReference(id) {
        try {
            const response = await API.references.get(this.currentReference, id);
            if (!response.success) {
                this.notify('Ошибка загрузки записи', 'error');
                return;
            }
            
            const data = response.data;
            const formHtml = this.getReferenceForm(this.currentReference, data);
            
            const content = `
                <form id="ref-form">
                    <input type="hidden" name="id" value="${data.id}">
                    ${formHtml}
                </form>
            `;

            const footer = `
                <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
                <button class="btn btn-danger" id="btn-delete-ref" onclick="App.deleteReference(${id})" style="margin-right: auto;">
                    <i class="fas fa-trash"></i> Удалить
                </button>
                <button class="btn btn-primary" onclick="App.submitReferenceUpdate(${id})">Сохранить</button>
            `;

            this.showModal('Редактировать запись', content, footer);

            // Системные виды объектов не удаляем (скрываем кнопку)
        if (this.currentReference === 'object_types' || !this.isAdmin()) {
                document.getElementById('btn-delete-ref')?.classList.add('hidden');
            }
            
            // Загружаем связанные справочники
            await this.loadReferenceFormSelects();
            
            // Устанавливаем значения селектов
            setTimeout(() => {
                const selects = ['ref-object-type-select', 'ref-owner-select', 'ref-landlord-select', 'ref-cable-type-select'];
                selects.forEach(selectId => {
                    const select = document.getElementById(selectId);
                    if (select && select.dataset.value) {
                        select.value = select.dataset.value;
                    }
                });
            }, 100);
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Загрузка селектов для формы справочника
     */
    async loadReferenceFormSelects() {
        try {
            // Виды объектов
            const objectTypeSelect = document.getElementById('ref-object-type-select');
            if (objectTypeSelect) {
                const types = await API.references.all('object_types');
                if (types.success) {
                    objectTypeSelect.innerHTML = '<option value="">Не указан</option>' +
                        types.data.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
                    const defaultType = (types.data || []).find(t => t.is_default);
                    if (objectTypeSelect.dataset.value) {
                        objectTypeSelect.value = objectTypeSelect.dataset.value;
                    } else if (defaultType) {
                        objectTypeSelect.value = String(defaultType.id);
                    }
                }
            }
            
            // Собственники
            const ownerSelect = document.getElementById('ref-owner-select');
            const landlordSelect = document.getElementById('ref-landlord-select');
            if (ownerSelect) {
                const owners = await API.references.all('owners');
                if (owners.success) {
                    ownerSelect.innerHTML = '<option value="">Не указан</option>' +
                        owners.data.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
                    const defaultOwner = (owners.data || []).find(o => o.is_default);
                    if (ownerSelect.dataset.value) {
                        ownerSelect.value = ownerSelect.dataset.value;
                    } else if (defaultOwner) {
                        ownerSelect.value = String(defaultOwner.id);
                    }
                }
            }
            if (landlordSelect) {
                const owners = await API.references.all('owners');
                if (owners.success) {
                    landlordSelect.innerHTML = '<option value="">Не указан</option>' +
                        owners.data.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
                    const defaultOwner = (owners.data || []).find(o => o.is_default);
                    if (landlordSelect.dataset.value) {
                        landlordSelect.value = landlordSelect.dataset.value;
                    } else if (defaultOwner) {
                        landlordSelect.value = String(defaultOwner.id);
                    }
                }
            }
            
            // Типы кабелей
            const cableTypeSelect = document.getElementById('ref-cable-type-select');
            if (cableTypeSelect) {
                const cableTypes = await API.references.all('cable_types');
                if (cableTypes.success) {
                    cableTypeSelect.innerHTML = '<option value="">Выберите тип</option>' +
                        cableTypes.data.map(ct => `<option value="${ct.id}">${ct.name}</option>`).join('');
                    const defaultCableType = (cableTypes.data || []).find(ct => ct.is_default);
                    if (cableTypeSelect.dataset.value) {
                        cableTypeSelect.value = cableTypeSelect.dataset.value;
                    } else if (defaultCableType) {
                        cableTypeSelect.value = String(defaultCableType.id);
                    }
                }
            }
        } catch (error) {
            console.error('Ошибка загрузки справочников для формы:', error);
        }
    },

    /**
     * Отправка формы справочника (создание)
     */
    async submitReference() {
        const form = document.getElementById('ref-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        
        // Обработка чекбоксов (только если поле есть в форме)
        const isDefaultCheckbox = form.querySelector('input[name="is_default"]');
        if (isDefaultCheckbox !== null) {
            data.is_default = isDefaultCheckbox.checked ? true : false;
        }

        try {
            const response = await API.references.create(this.currentReference, data);
            if (response.success) {
                this.hideModal();
                this.notify('Запись создана', 'success');
                if (this.currentPanel === 'contracts' && this.currentReference === 'contracts') {
                    this.loadContractsPanel();
                } else {
                    this.showReference(this.currentReference);
                }
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Отправка формы справочника (обновление)
     */
    async submitReferenceUpdate(id) {
        const form = document.getElementById('ref-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        delete data.id;
        
        // Обработка чекбоксов
        const isDefaultCheckbox = form.querySelector('input[name="is_default"]');
        if (isDefaultCheckbox !== null) {
            data.is_default = isDefaultCheckbox.checked ? true : false;
        }

        try {
            const response = await API.references.update(this.currentReference, id, data);
            if (response.success) {
                this.hideModal();
                this.notify('Запись обновлена', 'success');
                if (this.currentPanel === 'contracts' && this.currentReference === 'contracts') {
                    this.loadContractsPanel();
                } else {
                    this.showReference(this.currentReference);
                }
                if (this.currentReference === 'object_types') {
                    this.refreshObjectTypeColors(true).catch(() => {});
                }
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Удаление записи справочника
     */
    async deleteReference(id) {
        if (!confirm('Удалить эту запись?')) return;

        try {
            const response = await API.references.delete(this.currentReference, id);
            if (response.success) {
                this.hideModal();
                this.notify('Запись удалена', 'success');
                this.showReference(this.currentReference);
            } else {
                this.notify(response.message || 'Ошибка', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Показ инцидента в модальном окне
     */
    async editIncident(id) {
        try {
            const resp = await API.incidents.get(id);
            if (!resp?.success) {
                this.notify(resp?.message || 'Ошибка загрузки инцидента', 'error');
                return;
            }
            this.showEditIncidentModal(resp.data);
        } catch (e) {
            this.notify('Ошибка загрузки инцидента', 'error');
        }
    },

    showEditIncidentModal(incident) {
        this.incidentDraftRelatedObjects = (incident.related_objects || []).map(o => ({
            type: o.object_type,
            id: parseInt(o.id),
            number: o.number || null,
        }));

        const content = `
            <form id="incident-edit-form">
                <div class="form-group">
                    <label>Номер *</label>
                    <input type="text" name="number" value="${incident.number || ''}" required>
                </div>
                <div class="form-group">
                    <label>Заголовок *</label>
                    <input type="text" name="title" value="${incident.title || ''}" required>
                </div>
                <div class="form-group">
                    <label>Дата инцидента *</label>
                    <input type="datetime-local" name="incident_date" value="${(incident.incident_date || '').slice(0, 16)}" required>
                </div>
                <div class="form-group">
                    <label>Статус</label>
                    <select name="status">
                        <option value="open" ${incident.status === 'open' ? 'selected' : ''}>Открыт</option>
                        <option value="in_progress" ${incident.status === 'in_progress' ? 'selected' : ''}>В работе</option>
                        <option value="resolved" ${incident.status === 'resolved' ? 'selected' : ''}>Решён</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Приоритет</label>
                    <select name="priority">
                        <option value="low" ${incident.priority === 'low' ? 'selected' : ''}>Низкий</option>
                        <option value="normal" ${incident.priority === 'normal' ? 'selected' : ''}>Обычный</option>
                        <option value="high" ${incident.priority === 'high' ? 'selected' : ''}>Высокий</option>
                        <option value="critical" ${incident.priority === 'critical' ? 'selected' : ''}>Критический</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Описание</label>
                    <textarea name="description" rows="4">${incident.description || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Виновник</label>
                    <input type="text" name="culprit" value="${incident.culprit || ''}">
                </div>
                <div class="form-group">
                    <label>Решение</label>
                    <textarea name="resolution" rows="3">${incident.resolution || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Примечания</label>
                    <textarea name="notes" rows="2">${incident.notes || ''}</textarea>
                </div>
                <hr>
                <h4>Связанные объекты</h4>
                <div id="incident-related-objects" class="text-muted">Нет объектов</div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="App.startIncidentSelectFromEdit(${incident.id})" style="margin-top: 8px;">
                    <i class="fas fa-crosshairs"></i> Добавить объект с карты
                </button>
                <hr>
                <h4>Фото</h4>
                <div id="object-photos" data-object-table="incidents" data-object-id="${incident.id}">
                    <div class="text-muted">Загрузка...</div>
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label>Добавить фото</label>
                    <input type="file" id="object-photo-file" accept="image/*">
                    <input type="text" id="object-photo-description" placeholder="Описание (необязательно)" style="margin-top: 8px;">
                    <button type="button" class="btn btn-sm btn-secondary" onclick="App.uploadObjectPhoto()" style="margin-top: 8px;">
                        <i class="fas fa-upload"></i> Загрузить
                    </button>
                </div>
                <hr>
                <h4>Документы</h4>
                <div id="incident-documents" data-incident-id="${incident.id}">
                    <div class="text-muted">Загрузка...</div>
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label>Добавить документ</label>
                    <input type="file" id="incident-doc-file">
                    <input type="text" id="incident-doc-description" placeholder="Описание (необязательно)" style="margin-top: 8px;">
                    <button type="button" class="btn btn-sm btn-secondary" onclick="App.uploadIncidentDocument(${incident.id})" style="margin-top: 8px;">
                        <i class="fas fa-upload"></i> Загрузить
                    </button>
                </div>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
            <button class="btn btn-danger" onclick="App.deleteIncident(${incident.id})" style="margin-left:auto;">
                <i class="fas fa-trash"></i> Удалить
            </button>
            <button class="btn btn-primary" onclick="App.submitIncidentUpdate(${incident.id})">
                <i class="fas fa-save"></i> Сохранить
            </button>
        `;

        this.showModal(`Редактировать инцидент: ${incident.number}`, content, footer);
        this.renderIncidentRelatedObjects();
        this.loadObjectPhotos('incidents', incident.id).catch(() => {});
        this.loadIncidentDocuments(incident.id).catch(() => {});
    },

    startIncidentSelectFromEdit(incidentId) {
        const form = document.getElementById('incident-edit-form');
        const draft = form ? Object.fromEntries(new FormData(form).entries()) : {};
        this._incidentEditPick = {
            id: incidentId,
            draft,
            related: [...(this.incidentDraftRelatedObjects || [])],
        };

        this.hideModal();
        this.switchPanel('map');
        MapManager.startIncidentSelectMode();
    },

    async submitIncidentUpdate(id) {
        const form = document.getElementById('incident-edit-form');
        if (!form) return;
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        data.related_objects = this.incidentDraftRelatedObjects;

        try {
            const resp = await API.incidents.update(id, data);
            if (resp?.success) {
                this.hideModal();
                this.notify('Инцидент обновлён', 'success');
                this.loadIncidents();
            } else {
                this.notify(resp?.message || 'Ошибка', 'error');
            }
        } catch (e) {
            this.notify('Ошибка', 'error');
        }
    },

    async deleteIncident(id) {
        if (!confirm('Удалить инцидент?')) return;
        try {
            const resp = await API.incidents.delete(id);
            if (resp?.success) {
                this.hideModal();
                this.notify('Инцидент удалён', 'success');
                this.loadIncidents();
            } else {
                this.notify(resp?.message || 'Ошибка', 'error');
            }
        } catch (e) {
            this.notify('Ошибка', 'error');
        }
    },

    async loadIncidentDocuments(incidentId) {
        const container = document.getElementById('incident-documents');
        if (!container) return;
        container.innerHTML = `<div class="text-muted">Загрузка...</div>`;
        const resp = await API.incidents.documents(incidentId);
        if (!resp?.success) {
            container.innerHTML = `<div class="text-muted">Не удалось загрузить документы</div>`;
            return;
        }
        const docs = resp.data || [];
        if (!docs.length) {
            container.innerHTML = `<div class="text-muted">Документов нет</div>`;
            return;
        }
        container.innerHTML = `
            <div style="display:grid; gap:8px;">
                ${docs.map(d => `
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 8px; border:1px solid var(--border-color); border-radius:6px;">
                        <a href="${d.url}" target="_blank" rel="noopener">${d.original_filename || d.filename}</a>
                        <button type="button" class="btn btn-sm btn-danger" onclick="App.deleteIncidentDocument(${d.id}, ${incidentId})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    },

    async uploadIncidentDocument(incidentId) {
        const fileInput = document.getElementById('incident-doc-file');
        const desc = document.getElementById('incident-doc-description')?.value || '';
        const file = fileInput?.files?.[0];
        if (!file) {
            this.notify('Выберите файл', 'warning');
            return;
        }
        try {
            const resp = await API.incidents.uploadDocument(incidentId, file, desc);
            if (resp?.success) {
                fileInput.value = '';
                const d = document.getElementById('incident-doc-description');
                if (d) d.value = '';
                this.notify('Документ загружен', 'success');
                await this.loadIncidentDocuments(incidentId);
            } else {
                this.notify(resp?.message || 'Ошибка', 'error');
            }
        } catch (e) {
            this.notify('Ошибка', 'error');
        }
    },

    async deleteIncidentDocument(docId, incidentId) {
        if (!confirm('Удалить документ?')) return;
        try {
            const resp = await API.incidents.deleteDocument(docId);
            if (resp?.success) {
                this.notify('Документ удалён', 'success');
                await this.loadIncidentDocuments(incidentId);
            } else {
                this.notify(resp?.message || 'Ошибка', 'error');
            }
        } catch (e) {
            this.notify('Ошибка', 'error');
        }
    },

    showIncidentModal(incident) {
        const photosHtml = (incident.photos || []).length ? `
            <div>
                <strong>Фотографии:</strong>
                <ul style="margin-top:6px;">
                    ${(incident.photos || []).map(p => `
                        <li style="margin-bottom:6px;">
                            <a href="${p.url || '#'}" target="_blank" download="${this.escapeHtml(p.original_filename || 'photo')}" rel="noopener">
                                ${this.escapeHtml(p.original_filename || p.filename || 'Файл')}
                            </a>
                            ${p.description ? `<div class="text-muted" style="margin-top:2px;">${this.escapeHtml(p.description)}</div>` : ''}
                        </li>
                    `).join('')}
                </ul>
            </div>
        ` : '';

        const docsHtml = (incident.documents || []).length ? `
            <div>
                <strong>Документы:</strong>
                <ul style="margin-top:6px;">
                    ${(incident.documents || []).map(d => `
                        <li style="margin-bottom:6px;">
                            <a href="${d.url || '#'}" target="_blank" download="${this.escapeHtml(d.original_filename || 'document')}" rel="noopener">
                                ${this.escapeHtml(d.original_filename || d.filename || 'Файл')}
                            </a>
                            ${d.description ? `<div class="text-muted" style="margin-top:2px;">${this.escapeHtml(d.description)}</div>` : ''}
                        </li>
                    `).join('')}
                </ul>
            </div>
        ` : '';

        const content = `
            <div style="display: grid; gap: 12px;">
                <div><strong>Номер:</strong> ${incident.number}</div>
                <div><strong>Статус:</strong> <span class="incident-status ${incident.status}">${this.getStatusName(incident.status)}</span></div>
                <div><strong>Дата:</strong> ${this.formatDate(incident.incident_date)}</div>
                <div><strong>Приоритет:</strong> ${incident.priority}</div>
                <div><strong>Описание:</strong> ${incident.description || '-'}</div>
                <div><strong>Виновник:</strong> ${incident.culprit || '-'}</div>
                <div><strong>Создал:</strong> ${incident.created_by_name || incident.created_by_login}</div>
                ${photosHtml}
                ${docsHtml}
                ${incident.related_objects?.length ? `
                    <div><strong>Связанные объекты:</strong>
                        <ul>
                            ${incident.related_objects.map(o => `<li>${this.getIncidentObjectTypeName(o.object_type)}: ${o.number}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
                ${incident.history?.length ? `
                    <div><strong>История:</strong>
                        <ul>
                            ${incident.history.map(h => `<li>${this.formatDate(h.action_date)} - ${h.action_type}: ${h.description}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
            </div>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Закрыть</button>
            ${this.canDelete() ? `
                <button class="btn btn-danger" onclick="App.deleteIncident(${incident.id})" style="margin-left:auto;">
                    <i class="fas fa-trash"></i> Удалить
                </button>
            ` : ''}
            ${this.canWrite() ? `
                <button class="btn btn-primary" onclick="App.editIncident(${incident.id})" ${this.canDelete() ? '' : 'style="margin-left:auto;"'}>
                    <i class="fas fa-edit"></i> Редактировать
                </button>
            ` : ''}
        `;

        this.showModal(`Инцидент: ${incident.number}`, content, footer);
    },
};

// Запуск приложения при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    // Загружаем сохранённую тему
    const savedTheme = localStorage.getItem('igs_theme') || 'dark';
    document.body.className = `theme-${savedTheme}`;
    
    App.init();
});
