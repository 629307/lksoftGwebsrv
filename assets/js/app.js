/**
 * Основное приложение ИГС lksoftGwebsrv
 */

const App = {
    user: null,
    currentPanel: 'map',
    currentTab: 'wells',
    currentReference: null,
    pagination: { page: 1, limit: 50, total: 0 },

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
        document.getElementById('user-name').textContent = this.user.full_name || this.user.login;

        // Скрываем админ-панель для не-админов
        if (this.user.role.code !== 'admin') {
            document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        }

        // Инициализируем карту
        MapManager.init();

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

    /**
     * Привязка событий
     */
    bindEvents() {
        // Форма авторизации
        document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));

        // Выход
        document.getElementById('btn-logout').addEventListener('click', () => this.handleLogout());

        // Навигация
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => this.switchPanel(item.dataset.panel));
        });

        // Переключение темы
        document.getElementById('btn-theme-dark').addEventListener('click', () => this.setTheme('dark'));
        document.getElementById('btn-theme-grey').addEventListener('click', () => this.setTheme('grey'));

        // Переключение системы координат
        document.getElementById('btn-wgs84').addEventListener('click', () => this.setCoordinateSystem('wgs84'));
        document.getElementById('btn-msk86').addEventListener('click', () => this.setCoordinateSystem('msk86'));

        // Слои карты
        document.querySelectorAll('.layer-item input').forEach(input => {
            input.addEventListener('change', () => this.handleLayerToggle(input));
        });

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

        // Кнопки добавления
        document.getElementById('btn-add-object').addEventListener('click', () => this.showAddObjectModal(this.currentTab));
        document.getElementById('btn-import').addEventListener('click', () => this.showImportModal());
        document.getElementById('btn-export').addEventListener('click', () => this.exportObjects());

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

        // Админка
        document.getElementById('btn-add-user').addEventListener('click', () => this.showAddUserModal());

        // Модальное окно
        document.getElementById('btn-close-modal').addEventListener('click', () => this.hideModal());

        // Редактирование/удаление объекта
        document.getElementById('btn-edit-object').addEventListener('click', () => this.editCurrentObject());
        document.getElementById('btn-delete-object').addEventListener('click', () => this.deleteCurrentObject());

        // Панель инструментов карты
        document.getElementById('btn-add-direction-map')?.addEventListener('click', () => MapManager.startAddDirectionMode());
        document.getElementById('btn-add-well-map')?.addEventListener('click', () => MapManager.startAddingObject('wells'));
        document.getElementById('btn-add-ground-cable-map')?.addEventListener('click', () => MapManager.startAddCableMode('cable_ground'));
        document.getElementById('btn-add-aerial-cable-map')?.addEventListener('click', () => MapManager.startAddCableMode('cable_aerial'));
        document.getElementById('btn-cancel-add-mode')?.addEventListener('click', () => {
            MapManager.cancelAddDirectionMode();
            MapManager.cancelAddingObject();
            MapManager.cancelAddCableMode();
        });
        document.getElementById('btn-finish-add-mode')?.addEventListener('click', () => MapManager.finishAddCableMode());
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
                this.loadObjects();
                break;
            case 'incidents':
                this.loadIncidents();
                break;
            case 'admin':
                this.loadUsers();
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

    /**
     * Установка системы координат
     */
    setCoordinateSystem(system) {
        MapManager.setCoordinateSystem(system);
        document.getElementById('btn-wgs84').classList.toggle('active', system === 'wgs84');
        document.getElementById('btn-msk86').classList.toggle('active', system === 'msk86');
    },

    /**
     * Переключение слоя
     */
    handleLayerToggle(input) {
        const layerMap = {
            'layer-wells': 'wells',
            'layer-channels': 'channels',
            'layer-markers': 'markers',
            'layer-ground-cables': 'groundCables',
            'layer-aerial-cables': 'aerialCables',
            'layer-duct-cables': 'ductCables',
        };
        
        const layerName = layerMap[input.id];
        if (layerName) {
            MapManager.toggleLayer(layerName, input.checked);
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
                const groupsData = groups.data || groups;
                groupsData.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.name}</option>`;
                });
            }

            // Собственники
            const owners = await API.references.all('owners');
            if (owners.success) {
                const select = document.getElementById('filter-owner');
                owners.data.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.name}</option>`;
                });
            }

            // Состояния
            const statuses = await API.references.all('object_status');
            if (statuses.success) {
                const select = document.getElementById('filter-status');
                statuses.data.forEach(item => {
                    select.innerHTML += `<option value="${item.id}">${item.name}</option>`;
                });
            }

            // Контракты
            const contracts = await API.references.all('contracts');
            if (contracts.success) {
                const select = document.getElementById('filter-contract');
                contracts.data.forEach(item => {
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
        const groupId = document.getElementById('filter-group').value;
        const ownerId = document.getElementById('filter-owner').value;
        const statusId = document.getElementById('filter-status').value;
        const contractId = document.getElementById('filter-contract').value;
        
        // Собираем все фильтры
        const filters = {};
        if (ownerId) filters.owner_id = ownerId;
        if (statusId) filters.status_id = statusId;
        if (contractId) filters.contract_id = contractId;
        
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
        
        MapManager.clearFilters();
        this.notify('Фильтры сброшены', 'info');
    },

    /**
     * Переключение таба объектов
     */
    switchTab(tab) {
        this.currentTab = tab;
        this.pagination.page = 1;

        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });

        this.loadObjects();
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
        
        // Добавляем search только если он не пустой
        if (search) {
            params.search = search;
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
                    columns = ['number', 'name', 'object_count', 'group_type'];
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
            } else {
                console.error('API returned error:', response);
                this.notify('Ошибка загрузки данных', 'error');
            }
        } catch (error) {
            console.error('Ошибка загрузки объектов:', error);
            this.notify('Ошибка загрузки данных', 'error');
        }
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
            cable_type_name: 'Тип кабеля',
            object_type_name: 'Вид объекта',
            cable_marking: 'Маркировка',
        };

        // Заголовок
        header.innerHTML = columns.map(col => `<th>${columnNames[col] || col}</th>`).join('') + '<th>Действия</th>';

        // Тело таблицы
        body.innerHTML = data.map(row => `
            <tr data-id="${row.id}">
                ${columns.map(col => `<td>${row[col] || '-'}</td>`).join('')}
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.viewObject(${row.id})" title="Показать на карте">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn btn-sm btn-primary" onclick="App.editObject(${row.id})" title="Редактировать">
                        <i class="fas fa-edit"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    },

    /**
     * Отрисовка пагинации
     */
    renderPagination() {
        const container = document.getElementById('pagination');
        const { page, pages, total } = this.pagination;

        let html = '';
        
        if (page > 1) {
            html += `<button onclick="App.goToPage(${page - 1})"><i class="fas fa-chevron-left"></i></button>`;
        }

        for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) {
            html += `<button class="${i === page ? 'active' : ''}" onclick="App.goToPage(${i})">${i}</button>`;
        }

        if (page < pages) {
            html += `<button onclick="App.goToPage(${page + 1})"><i class="fas fa-chevron-right"></i></button>`;
        }

        container.innerHTML = html;
    },

    /**
     * Переход на страницу
     */
    goToPage(page) {
        this.pagination.page = page;
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
                    title = 'Редактирование группы';
                    break;
            }

            if (!response || response.success === false) {
                this.notify('Ошибка загрузки объекта', 'error');
                return;
            }

            const obj = response.data || response;
            
            // Загружаем список групп для возможности добавления объекта в группы
            const groupsResponse = await API.groups.list({ limit: 100 });
            const groups = groupsResponse.data || groupsResponse || [];

            let formHtml = '';

            if (type === 'wells') {
                formHtml = `
                    <form id="edit-object-form">
                        <input type="hidden" name="id" value="${obj.id}">
                        <div class="form-group">
                            <label>Номер *</label>
                            <input type="text" name="number" value="${obj.number || ''}" required>
                        </div>
                        <div class="form-group">
                            <label>Система координат</label>
                            <select id="coord-system-select" onchange="App.toggleCoordinateInputs()">
                                <option value="wgs84" selected>WGS84 (широта/долгота)</option>
                                <option value="msk86">МСК86 Зона 4 (X/Y)</option>
                            </select>
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
                        <div id="coords-msk86-inputs" style="display: none;">
                            <div class="form-group">
                                <label>X (МСК86)</label>
                                <input type="number" name="x_msk86" step="0.01" value="${obj.x_msk86 || ''}">
                            </div>
                            <div class="form-group">
                                <label>Y (МСК86)</label>
                                <input type="number" name="y_msk86" step="0.01" value="${obj.y_msk86 || ''}">
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
                            <label>Номер</label>
                            <input type="text" value="${obj.number || ''}" disabled style="background: var(--bg-tertiary);">
                        </div>
                        <div class="form-group">
                            <label>Система координат</label>
                            <select id="coord-system-select" onchange="App.toggleCoordinateInputs()">
                                <option value="wgs84" selected>WGS84 (широта/долгота)</option>
                                <option value="msk86">МСК86 Зона 4 (X/Y)</option>
                            </select>
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
                        <div id="coords-msk86-inputs" style="display: none;">
                            <div class="form-group">
                                <label>X (МСК86)</label>
                                <input type="number" name="x_msk86" step="0.01" value="${obj.x_msk86 || ''}">
                            </div>
                            <div class="form-group">
                                <label>Y (МСК86)</label>
                                <input type="number" name="y_msk86" step="0.01" value="${obj.y_msk86 || ''}">
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
                            <input type="text" name="number" value="${obj.number || ''}" required>
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
                            <label>Длина (м)</label>
                            <input type="number" name="length_m" step="0.01" value="${obj.length_m || ''}">
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>
                        <hr>
                        <h4>Каналы (${obj.channels ? obj.channels.length : 0} из 16)</h4>
                        <div id="channels-list" style="max-height: 200px; overflow-y: auto;">
                            ${obj.channels && obj.channels.length > 0 ? obj.channels.map(ch => `
                                <div class="channel-item" style="padding: 8px; border-bottom: 1px solid var(--border-color);">
                                    <strong>Канал ${ch.channel_number}</strong>: ${ch.kind_name || '-'} / ${ch.status_name || '-'}
                                </div>
                            `).join('') : '<p class="text-muted">Каналы не добавлены</p>'}
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
                        <div class="form-group">
                            <label>Номер</label>
                            <input type="text" value="${obj.number || ''}" disabled style="background: var(--bg-tertiary);">
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
                            <label>Дата установки</label>
                            <input type="date" name="installation_date" value="${obj.installation_date || ''}">
                        </div>
                        <div class="form-group">
                            <label>Примечания</label>
                            <textarea name="notes" rows="3">${obj.notes || ''}</textarea>
                        </div>

                        <div id="cable-geometry-block" style="display: none;">
                            <div class="form-group">
                                <label>Система координат</label>
                                <select id="cable-coord-system">
                                    <option value="wgs84">WGS84 (долгота, широта)</option>
                                    <option value="msk86">МСК86 Зона 4 (X, Y)</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Координаты (точки ломаной)</label>
                                <div id="cable-coordinates-list"></div>
                                <button type="button" class="btn btn-sm btn-secondary" onclick="App.addCableCoordinate()">
                                    <i class="fas fa-plus"></i> Добавить точку
                                </button>
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
                            <label>Название *</label>
                            <input type="text" name="name" value="${obj.name || ''}" required>
                        </div>
                        <div class="form-group">
                            <label>Тип группы</label>
                            <input type="text" name="group_type" value="${obj.group_type || ''}">
                        </div>
                        <div class="form-group">
                            <label>Описание</label>
                            <textarea name="description" rows="3">${obj.description || ''}</textarea>
                        </div>
                        <hr>
                        <h4>Объекты в группе (${obj.objects ? obj.objects.length : 0})</h4>
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
                    </form>
                `;
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
            
        } catch (error) {
            console.error('Ошибка загрузки объекта:', error);
            this.notify('Ошибка загрузки данных', 'error');
        }
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
            const selects = ['modal-owner-select', 'modal-kind-select', 'modal-status-select', 'modal-cable-type-select', 'modal-cable-catalog-select'];
            selects.forEach(selectId => {
                const select = document.getElementById(selectId);
                if (select && select.dataset.value) {
                    select.value = select.dataset.value;
                }
            });

            // Для кабелей — после установки типа загружаем каталог и применяем сохранённое значение
            if (type === 'unified_cables' && document.getElementById('modal-cable-type-select')?.value) {
                this.onCableTypeChange().then(() => {
                    const catalogSelect = document.getElementById('modal-cable-catalog-select');
                    if (catalogSelect && catalogSelect.dataset.value) {
                        catalogSelect.value = catalogSelect.dataset.value;
                    }
                });
            }
        }, 50);
    },

    /**
     * Отправка формы редактирования объекта
     */
    async submitEditObject(type, id) {
        const form = document.getElementById('edit-object-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        delete data.id;
        
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
                    // Для кабелей — добавляем координаты/маршрут если есть блоки
                    const objectTypeText = (document.querySelector('#edit-object-form input[disabled][value]')?.value || '').toString();
                    if (objectTypeText) {
                        // Если есть список координат — отправим coordinates
                        const coordsList = document.getElementById('cable-coordinates-list');
                        if (coordsList) {
                            const coordinates = this.collectCableCoordinates();
                            if (coordinates.length >= 2) {
                                data.coordinates = coordinates;
                                data.coordinate_system = document.getElementById('cable-coord-system')?.value || 'wgs84';
                            }
                        }
                        // Для duct-кабеля могли бы быть route_wells/route_channels — пока не редактируем через UI
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
                    <input type="number" name="diameter_mm">
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
            }

            container.innerHTML = `
                <div class="panel-header">
                    <h3>${this.getReportTitle(type)}</h3>
                    <button class="btn btn-secondary" onclick="API.reports.export('${type}')">
                        <i class="fas fa-download"></i> Экспорт CSV
                    </button>
                </div>
                ${html}
            `;
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
        };
        return titles[type] || 'Отчёт';
    },

    renderObjectsReport(data) {
        return `
            <table>
                <thead>
                    <tr><th>Тип объекта</th><th>Количество</th><th>Длина (м)</th></tr>
                </thead>
                <tbody>
                    ${data.summary.map(item => `
                        <tr>
                            <td>${item.object_name}</td>
                            <td>${item.count}</td>
                            <td>${item.total_length || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    },

    renderContractsReport(data) {
        return `
            <table>
                <thead>
                    <tr><th>Номер</th><th>Название</th><th>Собственник</th><th>Статус</th><th>Сумма</th></tr>
                </thead>
                <tbody>
                    ${data.contracts.map(c => `
                        <tr>
                            <td>${c.number}</td>
                            <td>${c.name}</td>
                            <td>${c.owner_name || '-'}</td>
                            <td>${c.status}</td>
                            <td>${c.amount || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    },

    renderOwnersReport(data) {
        return `
            <table>
                <thead>
                    <tr><th>Собственник</th><th>Колодцы</th><th>Направления</th><th>Столбики</th><th>Кабели</th><th>Всего</th></tr>
                </thead>
                <tbody>
                    ${data.map(o => `
                        <tr>
                            <td>${o.name}</td>
                            <td>${o.wells}</td>
                            <td>${o.channel_directions}</td>
                            <td>${o.marker_posts}</td>
                            <td>${o.ground_cables + o.aerial_cables + o.duct_cables}</td>
                            <td>${o.total_objects}</td>
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
            display_styles: 'Стили отображения',
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

    /**
     * Отрисовка таблицы справочника
     */
    renderReferenceTable(data) {
        if (!data || data.length === 0) {
            document.getElementById('ref-table-body').innerHTML = '<tr><td colspan="5">Нет данных</td></tr>';
            return;
        }

        const columns = Object.keys(data[0]).filter(k => !['id', 'created_at', 'updated_at', 'permissions'].includes(k));
        
        document.getElementById('ref-table-header').innerHTML = 
            columns.slice(0, 5).map(col => `<th>${col}</th>`).join('') + '<th>Действия</th>';
        
        document.getElementById('ref-table-body').innerHTML = data.map(row => `
            <tr>
                ${columns.slice(0, 5).map(col => `<td>${row[col] || '-'}</td>`).join('')}
                <td>
                    <button class="btn btn-sm btn-primary" onclick="App.editReference(${row.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="App.deleteReference(${row.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
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
                <td><span class="status-badge ${user.is_active ? 'active' : 'inactive'}">${user.is_active ? 'Да' : 'Нет'}</span></td>
                <td>${this.formatDate(user.last_login)}</td>
                <td>
                    <button class="btn btn-sm btn-primary" onclick="App.editUser(${user.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    },

    /**
     * Модальное окно
     */
    showModal(title, content, footer = '') {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = content;
        document.getElementById('modal-footer').innerHTML = footer;
        document.getElementById('modal').classList.remove('hidden');

        // Дата/время по умолчанию для пустых полей
        const modal = document.getElementById('modal');
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
        document.getElementById('modal').classList.add('hidden');
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
            groups: 'Создать группу',
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
            const numberPrefixLabel = 'ККС';
            formHtml = `
                <form id="add-object-form">
                    <input type="hidden" name="object_type_code" value="${objectTypeCodes[type] || ''}">
                    <div class="form-group">
                        <label>Номер *</label>
                        <div style="display: flex; gap: 8px;">
                            <input type="text" name="number_prefix" id="modal-number-prefix" readonly style="flex: 0 0 180px; background: var(--bg-tertiary);" value="${numberPrefixLabel}-">
                            <input type="text" name="number_suffix" id="modal-number-suffix" required placeholder="Например: ТУ-01" style="flex: 1;">
                        </div>
                        <p class="text-muted">Префикс формируется автоматически по собственнику</p>
                    </div>
                    <div class="form-group">
                        <label>Система координат</label>
                        <select id="coord-system-select" onchange="App.toggleCoordinateInputs()">
                            <option value="wgs84" selected>WGS84 (широта/долгота)</option>
                            <option value="msk86">МСК86 Зона 4 (X/Y)</option>
                        </select>
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
                    <div id="coords-msk86-inputs" style="display: none;">
                        <div class="form-group">
                            <label>X (МСК86)</label>
                            <input type="number" name="x_msk86" step="0.01" placeholder="4500000.00">
                        </div>
                        <div class="form-group">
                            <label>Y (МСК86)</label>
                            <input type="number" name="y_msk86" step="0.01" placeholder="6100000.00">
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
                        <input type="text" id="modal-marker-number" value="СТ-<код>-<id>" disabled style="background: var(--bg-tertiary);">
                        <p class="text-muted">Номер формируется автоматически по собственнику и ID</p>
                    </div>
                    <div class="form-group">
                        <label>Система координат</label>
                        <select id="coord-system-select" onchange="App.toggleCoordinateInputs()">
                            <option value="wgs84" selected>WGS84 (широта/долгота)</option>
                            <option value="msk86">МСК86 Зона 4 (X/Y)</option>
                        </select>
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
                    <div id="coords-msk86-inputs" style="display: none;">
                        <div class="form-group">
                            <label>X (МСК86)</label>
                            <input type="number" name="x_msk86" step="0.01" placeholder="4500000.00">
                        </div>
                        <div class="form-group">
                            <label>Y (МСК86)</label>
                            <input type="number" name="y_msk86" step="0.01" placeholder="6100000.00">
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
                        <label>Собственник</label>
                        <select name="owner_id" id="modal-owner-select"></select>
                    </div>
                    <div class="form-group" style="display: none;">
                        <label>Вид</label>
                        <select name="type_id" id="modal-type-select"></select>
                    </div>
                    <div class="form-group">
                        <label>Длина (м)</label>
                        <input type="number" name="length_m" step="0.01">
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
                        <input type="number" name="diameter_mm">
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
                        <label>Название *</label>
                        <input type="text" name="name" required>
                    </div>
                    <div class="form-group">
                        <label>Тип группы</label>
                        <input type="text" name="group_type">
                    </div>
                    <div class="form-group">
                        <label>Описание</label>
                        <textarea name="description" rows="3"></textarea>
                    </div>
                    <div class="form-group">
                        <label>Объекты в группе</label>
                        <div id="group-objects-container">
                            <p class="text-muted">Объекты можно добавить после создания группы</p>
                        </div>
                    </div>
                </form>
            `;
        } else if (type === 'unified_cables') {
            formHtml = `
                <form id="add-object-form">
                    <div class="form-group">
                        <label>Номер</label>
                        <input type="text" id="modal-cable-number" value="КАБ-<код>-<id>" disabled style="background: var(--bg-tertiary);">
                        <p class="text-muted">Номер формируется автоматически по собственнику и ID</p>
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
                        <label>Состояние</label>
                        <select name="status_id" id="modal-status-select"></select>
                    </div>
                    
                    <!-- Блок для кабелей в грунте и воздушных (координаты) -->
                    <div id="cable-geometry-block" style="display: none;">
                        <div class="form-group">
                            <label>Система координат</label>
                            <select id="cable-coord-system">
                                <option value="wgs84">WGS84 (долгота, широта)</option>
                                <option value="msk86">МСК86 Зона 4 (X, Y)</option>
                            </select>
                        </div>
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
                            <label>Колодцы маршрута</label>
                            <select multiple id="cable-route-wells" style="height: 100px; width: 100%;">
                            </select>
                            <p class="text-muted">Удерживайте Ctrl для выбора нескольких</p>
                        </div>
                        <div class="form-group">
                            <label>Каналы маршрута</label>
                            <select multiple id="cable-route-channels" style="height: 100px; width: 100%;">
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Длина заявленная (м)</label>
                            <input type="number" name="length_declared" step="0.01" placeholder="Введите длину вручную">
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
        
        // Загружаем справочники для селектов
        this.loadModalSelects(type);
    },

    /**
     * Переключение полей ввода координат
     */
    toggleCoordinateInputs() {
        const coordSystem = document.getElementById('coord-system-select')?.value;
        const wgs84Inputs = document.getElementById('coords-wgs84-inputs');
        const msk86Inputs = document.getElementById('coords-msk86-inputs');
        
        if (wgs84Inputs && msk86Inputs) {
            if (coordSystem === 'wgs84') {
                wgs84Inputs.style.display = 'block';
                msk86Inputs.style.display = 'none';
            } else {
                wgs84Inputs.style.display = 'none';
                msk86Inputs.style.display = 'block';
            }
        }
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
            }

            const results = await Promise.all(promises);
            const [owners, types, kinds, statuses] = results;
            
            // Определяем код вида объекта из скрытого поля
            const objectTypeCode = document.querySelector('input[name="object_type_code"]')?.value;

            if (owners.success && document.getElementById('modal-owner-select')) {
                document.getElementById('modal-owner-select').innerHTML = 
                    '<option value="">Выберите...</option>' +
                    owners.data.map(o => `<option value="${o.id}" data-code="${o.code || ''}">${o.name}</option>`).join('');
            }

            // Обновление префикса номера по выбранному собственнику
            const ownerSelect = document.getElementById('modal-owner-select');
            const prefixInput = document.getElementById('modal-number-prefix');
            const markerNumberInput = document.getElementById('modal-marker-number');
            const cableNumberInput = document.getElementById('modal-cable-number');
            if (ownerSelect && (prefixInput || markerNumberInput || cableNumberInput)) {
                const updatePrefix = () => {
                    const ownerCode = ownerSelect.selectedOptions?.[0]?.dataset?.code || '';
                    if (!ownerCode) return;
                    if (objectType === 'wells') {
                        if (prefixInput) prefixInput.value = `ККС-${ownerCode}-`;
                    } else if (objectType === 'markers') {
                        if (markerNumberInput) markerNumberInput.value = `СТ-${ownerCode}-<id>`;
                    } else if (objectType === 'unified_cables') {
                        if (cableNumberInput) cableNumberInput.value = `КАБ-${ownerCode}-<id>`;
                    }
                };
                ownerSelect.onchange = updatePrefix;
                updatePrefix();
            }
            
            if (types.success && document.getElementById('modal-type-select')) {
                const typeSelect = document.getElementById('modal-type-select');
                typeSelect.innerHTML = types.data.map(t => 
                    `<option value="${t.id}" data-code="${t.code}">${t.name}</option>`
                ).join('');
                
                // Автоматически выбираем вид объекта по коду
                if (objectTypeCode) {
                    const matchingType = types.data.find(t => t.code === objectTypeCode);
                    if (matchingType) {
                        typeSelect.value = matchingType.id;
                        // Обновляем список типов (kinds) для выбранного вида
                        this.filterKindsByType(matchingType.id, kinds.data);
                    }
                }
            }
            
            if (kinds.success && document.getElementById('modal-kind-select')) {
                // Сохраняем все типы для фильтрации
                this.allKinds = kinds.data;
                
                // Если уже выбран вид, фильтруем типы
                const typeSelect = document.getElementById('modal-type-select');
                if (typeSelect && typeSelect.value) {
                    this.filterKindsByType(typeSelect.value, kinds.data);
                } else {
                    document.getElementById('modal-kind-select').innerHTML = 
                        '<option value="">Выберите...</option>' +
                        kinds.data.map(k => `<option value="${k.id}">${k.name}</option>`).join('');
                }
            }
            
            if (statuses.success && document.getElementById('modal-status-select')) {
                document.getElementById('modal-status-select').innerHTML = 
                    statuses.data.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
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
                        cableTypesResponse.data.map(ct => `<option value="${ct.id}">${ct.name}</option>`).join('');
                }
                
                // Виды объектов для кабелей
                if (cableObjectTypesResponse?.success && document.getElementById('modal-cable-object-type')) {
                    document.getElementById('modal-cable-object-type').innerHTML = 
                        '<option value="">Выберите вид...</option>' +
                        cableObjectTypesResponse.data.map(ot => 
                            `<option value="${ot.id}" data-code="${ot.code}">${ot.name}</option>`
                        ).join('');
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
            filteredKinds.map(k => `<option value="${k.id}">${k.name}</option>`).join('');
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

        // Санитизация пользовательской части номера (разрешаем буквы/цифры/дефис/подчёркивание)
        const sanitizeSuffix = (value) => (value || '').toString().replace(/[^0-9A-Za-zА-Яа-яЁё_-]/g, '');

        // Формирование номера по правилам
        if (type === 'wells') {
            const prefix = (data.number_prefix || '').toString();
            const suffix = sanitizeSuffix(data.number_suffix);
            if (!suffix) {
                this.notify('Введите номер (часть после префикса)', 'error');
                return;
            }
            data.number = `${prefix}${suffix}`;
            delete data.number_prefix;
            delete data.number_suffix;
        }

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
                        data.coordinate_system = document.getElementById('cable-coord-system')?.value || 'wgs84';
                    } else if (objectTypeCode === 'cable_duct') {
                        // Для кабелей в канализации - собираем маршрут
                        const wellsSelect = document.getElementById('cable-route-wells');
                        const channelsSelect = document.getElementById('cable-route-channels');
                        
                        data.route_wells = Array.from(wellsSelect?.selectedOptions || []).map(o => parseInt(o.value));
                        data.route_channels = Array.from(channelsSelect?.selectedOptions || []).map(o => parseInt(o.value));
                    }
                    
                    response = await API.unifiedCables.create(data);
                    break;
            }

            if (response && response.success) {
                this.hideModal();
                this.notify('Объект создан', 'success');
                this.loadObjects();
                MapManager.loadAllLayers();
            } else {
                this.notify(response?.message || 'Ошибка создания', 'error');
            }
        } catch (error) {
            this.notify(error.message || 'Ошибка', 'error');
        }
    },

    /**
     * Экспорт объектов
     */
    exportObjects() {
        window.open(`/api/wells/export?token=${API.getToken()}`, '_blank');
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
                    <label>Собственник</label>
                    <select name="owner_id" id="modal-owner-select"></select>
                </div>
                <div class="form-group">
                    <label>Длина (м)</label>
                    <input type="number" name="length_m" step="0.01" placeholder="Авто-расчёт по координатам">
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
                this.onCableObjectTypeChange();
            }
        }

        // Заполняем координаты (WGS84: lon/lat)
        const coordSystemSelect = document.getElementById('cable-coord-system');
        if (coordSystemSelect) coordSystemSelect.value = 'wgs84';
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
     * Обработчик смены вида объекта кабеля
     */
    onCableObjectTypeChange() {
        const select = document.getElementById('modal-cable-object-type');
        const selectedOption = select.options[select.selectedIndex];
        const objectTypeCode = selectedOption?.dataset?.code || '';
        
        const geomBlock = document.getElementById('cable-geometry-block');
        const routeBlock = document.getElementById('cable-route-block');
        
        if (objectTypeCode === 'cable_duct') {
            // Кабель в канализации - показываем маршрут
            geomBlock.style.display = 'none';
            routeBlock.style.display = 'block';
            this.loadCableRouteOptions();
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
                    filteredCables.map(c => `<option value="${c.id}">${c.marking} (${c.fiber_count} жил)</option>`).join('');
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
    async loadCableRouteOptions() {
        try {
            const [wellsResponse, channelsResponse] = await Promise.all([
                API.wells.list({ limit: 1000 }),
                API.cableChannels.list({ limit: 1000 })
            ]);
            
            const wellsSelect = document.getElementById('cable-route-wells');
            const channelsSelect = document.getElementById('cable-route-channels');
            
            if (wellsSelect && wellsResponse.success !== false) {
                const wells = wellsResponse.data || wellsResponse;
                wellsSelect.innerHTML = wells.map(w => `<option value="${w.id}">${w.number}</option>`).join('');
            }
            
            if (channelsSelect && channelsResponse.success !== false) {
                const channels = channelsResponse.data || channelsResponse;
                channelsSelect.innerHTML = channels.map(c => 
                    `<option value="${c.id}">Канал ${c.channel_number} (${c.direction_number || '-'})</option>`
                ).join('');
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
     * Модальное окно импорта
     */
    showImportModal() {
        const content = `
            <form id="import-form">
                <div class="form-group">
                    <label>Тип объекта</label>
                    <select name="target_table" required>
                        <option value="wells">Колодцы</option>
                        <option value="marker_posts">Столбики</option>
                        <option value="ground_cables">Кабели в грунте</option>
                        <option value="aerial_cables">Воздушные кабели</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Файл CSV</label>
                    <input type="file" name="file" accept=".csv" required>
                </div>
                <div class="form-group">
                    <label>Система координат</label>
                    <select name="coordinate_system">
                        <option value="wgs84">WGS84 (долгота, широта)</option>
                        <option value="msk86">МСК86 Зона 4 (X, Y)</option>
                    </select>
                </div>
            </form>
            <div id="import-preview" class="hidden" style="margin-top: 16px;"></div>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.previewImport()">Предпросмотр</button>
        `;

        this.showModal('Импорт данных', content, footer);
    },

    /**
     * Предпросмотр импорта
     */
    async previewImport() {
        const form = document.getElementById('import-form');
        const file = form.querySelector('input[name="file"]').files[0];
        
        if (!file) {
            this.notify('Выберите файл', 'warning');
            return;
        }

        try {
            const response = await API.import.previewCsv(file);
            if (response.success) {
                const preview = document.getElementById('import-preview');
                preview.classList.remove('hidden');
                preview.innerHTML = `
                    <p>Найдено ${response.data.total_rows} записей</p>
                    <p>Колонки: ${response.data.headers.join(', ')}</p>
                    <button class="btn btn-success" onclick="App.executeImport()">Выполнить импорт</button>
                `;
            }
        } catch (error) {
            this.notify('Ошибка чтения файла', 'error');
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
                    <label>Описание</label>
                    <textarea name="description" rows="4"></textarea>
                </div>
                <div class="form-group">
                    <label>Виновник</label>
                    <input type="text" name="culprit">
                </div>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitIncident()">Создать</button>
        `;

        this.showModal('Создать инцидент', content, footer);
    },

    /**
     * Отправка формы инцидента
     */
    async submitIncident() {
        const form = document.getElementById('incident-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

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

    /**
     * Показ модального окна добавления пользователя
     */
    showAddUserModal() {
        const content = `
            <form id="user-form">
                <div class="form-group">
                    <label>Логин *</label>
                    <input type="text" name="login" required>
                </div>
                <div class="form-group">
                    <label>Пароль *</label>
                    <input type="password" name="password" required>
                </div>
                <div class="form-group">
                    <label>Полное имя</label>
                    <input type="text" name="full_name">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" name="email">
                </div>
                <div class="form-group">
                    <label>Роль *</label>
                    <select name="role_id" required id="user-role-select"></select>
                </div>
            </form>
        `;

        const footer = `
            <button class="btn btn-secondary" onclick="App.hideModal()">Отмена</button>
            <button class="btn btn-primary" onclick="App.submitUser()">Создать</button>
        `;

        this.showModal('Добавить пользователя', content, footer);
        this.loadRolesSelect();
    },

    /**
     * Загрузка ролей в селект
     */
    async loadRolesSelect() {
        try {
            const response = await API.users.roles();
            if (response.success) {
                document.getElementById('user-role-select').innerHTML = 
                    response.data.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
            }
        } catch (error) {
            console.error('Ошибка загрузки ролей:', error);
        }
    },

    /**
     * Отправка формы пользователя
     */
    async submitUser() {
        const form = document.getElementById('user-form');
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

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
        const forms = {
            'object_types': `
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
                <div class="form-group">
                    <label>Иконка</label>
                    <input type="text" name="icon" value="${data.icon || ''}" placeholder="circle, line, marker...">
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
            `,
            'owners': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required>
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
                    <label>Собственник</label>
                    <select name="owner_id" id="ref-owner-select" data-value="${data.owner_id || ''}"></select>
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
            `,
            'display_styles': `
                <div class="form-group">
                    <label>Код *</label>
                    <input type="text" name="code" value="${data.code || ''}" required>
                </div>
                <div class="form-group">
                    <label>Название *</label>
                    <input type="text" name="name" value="${data.name || ''}" required>
                </div>
                <div class="form-group">
                    <label>Тип стиля *</label>
                    <select name="style_type" required>
                        <option value="point" ${data.style_type === 'point' ? 'selected' : ''}>Точка</option>
                        <option value="line" ${data.style_type === 'line' ? 'selected' : ''}>Линия</option>
                        <option value="polygon" ${data.style_type === 'polygon' ? 'selected' : ''}>Полигон</option>
                    </select>
                </div>
                <div class="form-group">
                    <label><input type="checkbox" name="is_default" ${data.is_default ? 'checked' : ''}> По умолчанию</label>
                </div>
                <hr>
                <h4>Стиль маркера</h4>
                <div class="form-group">
                    <label>Иконка</label>
                    <input type="text" name="marker_icon" value="${data.marker_icon || ''}">
                </div>
                <div class="form-group">
                    <label>Размер</label>
                    <input type="number" name="marker_size" value="${data.marker_size || 24}">
                </div>
                <div class="form-group">
                    <label>Цвет маркера</label>
                    <input type="color" name="marker_color" value="${data.marker_color || '#3498db'}">
                </div>
                <hr>
                <h4>Стиль линии</h4>
                <div class="form-group">
                    <label>Цвет обводки</label>
                    <input type="color" name="stroke_color" value="${data.stroke_color || '#2980b9'}">
                </div>
                <div class="form-group">
                    <label>Толщина</label>
                    <input type="number" name="stroke_width" value="${data.stroke_width || 2}">
                </div>
                <div class="form-group">
                    <label>Пунктир (dasharray)</label>
                    <input type="text" name="stroke_dasharray" value="${data.stroke_dasharray || ''}" placeholder="5,5">
                </div>
                <hr>
                <h4>Стиль заливки</h4>
                <div class="form-group">
                    <label>Цвет заливки</label>
                    <input type="color" name="fill_color" value="${data.fill_color || '#3498db'}">
                </div>
                <div class="form-group">
                    <label>Прозрачность (0-1)</label>
                    <input type="number" name="fill_opacity" step="0.1" min="0" max="1" value="${data.fill_opacity || 0.5}">
                </div>
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
                <button class="btn btn-danger" onclick="App.deleteReference(${id})" style="margin-right: auto;">
                    <i class="fas fa-trash"></i> Удалить
                </button>
                <button class="btn btn-primary" onclick="App.submitReferenceUpdate(${id})">Сохранить</button>
            `;

            this.showModal('Редактировать запись', content, footer);
            
            // Загружаем связанные справочники
            await this.loadReferenceFormSelects();
            
            // Устанавливаем значения селектов
            setTimeout(() => {
                const selects = ['ref-object-type-select', 'ref-owner-select', 'ref-cable-type-select'];
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
                    if (objectTypeSelect.dataset.value) {
                        objectTypeSelect.value = objectTypeSelect.dataset.value;
                    }
                }
            }
            
            // Собственники
            const ownerSelect = document.getElementById('ref-owner-select');
            if (ownerSelect) {
                const owners = await API.references.all('owners');
                if (owners.success) {
                    ownerSelect.innerHTML = '<option value="">Не указан</option>' +
                        owners.data.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
                    if (ownerSelect.dataset.value) {
                        ownerSelect.value = ownerSelect.dataset.value;
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
                    if (cableTypeSelect.dataset.value) {
                        cableTypeSelect.value = cableTypeSelect.dataset.value;
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
        
        // Обработка чекбоксов
        data.is_default = form.querySelector('input[name="is_default"]')?.checked ? true : false;

        try {
            const response = await API.references.create(this.currentReference, data);
            if (response.success) {
                this.hideModal();
                this.notify('Запись создана', 'success');
                this.showReference(this.currentReference);
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
                this.showReference(this.currentReference);
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
    showIncidentModal(incident) {
        const content = `
            <div style="display: grid; gap: 12px;">
                <div><strong>Номер:</strong> ${incident.number}</div>
                <div><strong>Статус:</strong> <span class="incident-status ${incident.status}">${this.getStatusName(incident.status)}</span></div>
                <div><strong>Дата:</strong> ${this.formatDate(incident.incident_date)}</div>
                <div><strong>Приоритет:</strong> ${incident.priority}</div>
                <div><strong>Описание:</strong> ${incident.description || '-'}</div>
                <div><strong>Виновник:</strong> ${incident.culprit || '-'}</div>
                <div><strong>Создал:</strong> ${incident.created_by_name || incident.created_by_login}</div>
                ${incident.related_objects?.length ? `
                    <div><strong>Связанные объекты:</strong>
                        <ul>
                            ${incident.related_objects.map(o => `<li>${o.object_type}: ${o.number}</li>`).join('')}
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
