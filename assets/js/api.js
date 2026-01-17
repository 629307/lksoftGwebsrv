/**
 * API Client для ИГС lksoftGwebsrv
 */

const API = {
    baseUrl: '/api',
    token: null,

    /**
     * Установка токена авторизации
     */
    setToken(token) {
        this.token = token;
        localStorage.setItem('igs_token', token);
    },

    /**
     * Получение токена из localStorage
     */
    getToken() {
        if (!this.token) {
            this.token = localStorage.getItem('igs_token');
        }
        return this.token;
    },

    /**
     * Очистка токена
     */
    clearToken() {
        this.token = null;
        localStorage.removeItem('igs_token');
    },

    /**
     * Базовый HTTP запрос
     */
    async request(endpoint, options = {}) {
        const url = this.baseUrl + endpoint;
        
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const config = {
            method: options.method || 'GET',
            headers,
            ...options,
        };

        if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
            config.body = JSON.stringify(options.body);
        } else if (options.body instanceof FormData) {
            delete headers['Content-Type'];
            config.body = options.body;
        }

        try {
            const response = await fetch(url, config);
            const data = await response.json();

            if (!response.ok) {
                if (response.status === 401) {
                    this.clearToken();
                    window.location.reload();
                }
                throw new Error(data.message || 'Ошибка запроса');
            }

            return data;
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    },

    /**
     * GET запрос
     */
    get(endpoint, params = {}) {
        const query = new URLSearchParams(params).toString();
        const url = query ? `${endpoint}?${query}` : endpoint;
        return this.request(url);
    },

    /**
     * POST запрос
     */
    post(endpoint, body = {}) {
        return this.request(endpoint, { method: 'POST', body });
    },

    /**
     * PUT запрос
     */
    put(endpoint, body = {}) {
        return this.request(endpoint, { method: 'PUT', body });
    },

    /**
     * DELETE запрос
     */
    delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    },

    /**
     * Загрузка файла
     */
    upload(endpoint, formData) {
        return this.request(endpoint, {
            method: 'POST',
            body: formData,
        });
    },

    // ========================
    // Авторизация
    // ========================

    auth: {
        async login(login, password) {
            const data = await API.post('/auth/login', { login, password });
            if (data.success && data.data.token) {
                API.setToken(data.data.token);
            }
            return data;
        },

        async logout() {
            const data = await API.post('/auth/logout');
            API.clearToken();
            return data;
        },

        async me() {
            return API.get('/auth/me');
        },

        async changePassword(currentPassword, newPassword) {
            return API.put('/auth/password', { current_password: currentPassword, new_password: newPassword });
        },

        async register(userData) {
            return API.post('/auth/register', userData);
        },
    },

    // ========================
    // Пользователи
    // ========================

    users: {
        list() {
            return API.get('/users');
        },

        update(id, data) {
            return API.put(`/users/${id}`, data);
        },

        delete(id) {
            return API.delete(`/users/${id}`);
        },

        roles() {
            return API.get('/roles');
        },
    },

    // ========================
    // Справочники
    // ========================

    references: {
        types() {
            return API.get('/references');
        },

        list(type, params = {}) {
            return API.get(`/references/${type}`, params);
        },

        all(type) {
            return API.get(`/references/${type}/all`);
        },

        get(type, id) {
            return API.get(`/references/${type}/${id}`);
        },

        create(type, data) {
            return API.post(`/references/${type}`, data);
        },

        update(type, id, data) {
            return API.put(`/references/${type}/${id}`, data);
        },

        delete(type, id) {
            return API.delete(`/references/${type}/${id}`);
        },
    },

    // ========================
    // Колодцы
    // ========================

    wells: {
        list(params = {}) {
            return API.get('/wells', params);
        },

        geojson(params = {}) {
            return API.get('/wells/geojson', params);
        },

        get(id) {
            return API.get(`/wells/${id}`);
        },

        create(data) {
            return API.post('/wells', data);
        },

        update(id, data) {
            return API.put(`/wells/${id}`, data);
        },

        delete(id) {
            return API.delete(`/wells/${id}`);
        },
    },

    // ========================
    // Направления каналов
    // ========================

    channelDirections: {
        list(params = {}) {
            return API.get('/channel-directions', params);
        },

        geojson(params = {}) {
            return API.get('/channel-directions/geojson', params);
        },

        get(id) {
            return API.get(`/channel-directions/${id}`);
        },

        create(data) {
            return API.post('/channel-directions', data);
        },

        update(id, data) {
            return API.put(`/channel-directions/${id}`, data);
        },

        delete(id) {
            return API.delete(`/channel-directions/${id}`);
        },

        addChannel(directionId, data) {
            return API.post(`/channel-directions/${directionId}/channels`, data);
        },
    },

    // ========================
    // Каналы (дочерние объекты направлений)
    // ========================

    cableChannels: {
        list(params = {}) {
            return API.get('/cable-channels', params);
        },

        get(id) {
            return API.get(`/cable-channels/${id}`);
        },

        update(id, data) {
            return API.put(`/cable-channels/${id}`, data);
        },

        delete(id) {
            return API.delete(`/cable-channels/${id}`);
        },
    },

    // ========================
    // Кабели (старые таблицы)
    // ========================

    cables: {
        list(type, params = {}) {
            return API.get(`/cables/${type}`, params);
        },

        geojson(type, params = {}) {
            return API.get(`/cables/${type}/geojson`, params);
        },

        allGeojson(params = {}) {
            return API.get('/cables/all/geojson', params);
        },

        get(type, id) {
            return API.get(`/cables/${type}/${id}`);
        },

        create(type, data) {
            return API.post(`/cables/${type}`, data);
        },

        update(type, id, data) {
            return API.put(`/cables/${type}/${id}`, data);
        },

        delete(type, id) {
            return API.delete(`/cables/${type}/${id}`);
        },
    },

    // ========================
    // Унифицированные кабели (новая таблица)
    // ========================

    unifiedCables: {
        list(params = {}) {
            return API.get('/unified-cables', params);
        },

        geojson(params = {}) {
            return API.get('/unified-cables/geojson', params);
        },

        objectTypes() {
            return API.get('/unified-cables/object-types');
        },

        get(id) {
            return API.get(`/unified-cables/${id}`);
        },

        create(data) {
            return API.post('/unified-cables', data);
        },

        update(id, data) {
            return API.put(`/unified-cables/${id}`, data);
        },

        delete(id) {
            return API.delete(`/unified-cables/${id}`);
        },

        recalculateLength(id) {
            return API.get(`/unified-cables/${id}/recalculate-length`);
        },

        byWell(wellId) {
            return API.get(`/unified-cables/by-well/${wellId}`);
        },

        byDirection(directionId) {
            return API.get(`/unified-cables/by-direction/${directionId}`);
        },

        byChannel(channelId) {
            return API.get(`/unified-cables/by-channel/${channelId}`);
        },

        routeDirectionsGeojson(id) {
            return API.get(`/unified-cables/${id}/route-directions-geojson`);
        },
    },

    // ========================
    // Столбики
    // ========================

    markerPosts: {
        list(params = {}) {
            return API.get('/marker-posts', params);
        },

        geojson(params = {}) {
            return API.get('/marker-posts/geojson', params);
        },

        get(id) {
            return API.get(`/marker-posts/${id}`);
        },

        create(data) {
            return API.post('/marker-posts', data);
        },

        update(id, data) {
            return API.put(`/marker-posts/${id}`, data);
        },

        delete(id) {
            return API.delete(`/marker-posts/${id}`);
        },
    },

    // ========================
    // Инциденты
    // ========================

    incidents: {
        list(params = {}) {
            return API.get('/incidents', params);
        },

        get(id) {
            return API.get(`/incidents/${id}`);
        },

        create(data) {
            return API.post('/incidents', data);
        },

        update(id, data) {
            return API.put(`/incidents/${id}`, data);
        },

        delete(id) {
            return API.delete(`/incidents/${id}`);
        },

        addHistory(id, data) {
            return API.post(`/incidents/${id}/history`, data);
        },
    },

    // ========================
    // Группы
    // ========================

    groups: {
        list(params = {}) {
            return API.get('/groups', params);
        },

        get(id) {
            return API.get(`/groups/${id}`);
        },

        geojson(id) {
            return API.get(`/groups/${id}/geojson`);
        },

        create(data) {
            return API.post('/groups', data);
        },

        update(id, data) {
            return API.put(`/groups/${id}`, data);
        },

        delete(id) {
            return API.delete(`/groups/${id}`);
        },

        addObjects(id, objects) {
            return API.post(`/groups/${id}/objects`, { objects });
        },

        removeObjects(id, objects) {
            return API.request(`/groups/${id}/objects`, { 
                method: 'DELETE',
                body: { objects }
            });
        },
    },

    // ========================
    // Фотографии
    // ========================

    photos: {
        upload(objectTable, objectId, file, description = '') {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('object_table', objectTable);
            formData.append('object_id', objectId);
            formData.append('description', description);
            return API.upload('/photos', formData);
        },

        get(id) {
            return API.get(`/photos/${id}`);
        },

        byObject(table, id) {
            return API.get(`/photos/object/${table}/${id}`);
        },

        delete(id) {
            return API.delete(`/photos/${id}`);
        },

        reorder(order) {
            return API.post('/photos/reorder', { order });
        },
    },

    // ========================
    // Импорт
    // ========================

    import: {
        previewCsv(file) {
            const formData = new FormData();
            formData.append('file', file);
            return API.upload('/import/preview', formData);
        },

        importCsv(file, targetTable, columnMapping, coordinateSystem = 'wgs84') {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('target_table', targetTable);
            formData.append('column_mapping', JSON.stringify(columnMapping));
            formData.append('coordinate_system', coordinateSystem);
            return API.upload('/import/csv', formData);
        },

        mapInfo(files) {
            const formData = new FormData();
            files.forEach(file => formData.append('files[]', file));
            return API.upload('/import/mapinfo', formData);
        },

        confirmMapInfo(targetTable, data, columnMapping, coordinateSystem = 'wgs84') {
            return API.post('/import/mapinfo/confirm', {
                target_table: targetTable,
                data,
                column_mapping: columnMapping,
                coordinate_system: coordinateSystem,
            });
        },
    },

    // ========================
    // Отчёты
    // ========================

    reports: {
        objects(params = {}) {
            return API.get('/reports/objects', params);
        },

        contracts() {
            return API.get('/reports/contracts');
        },

        owners() {
            return API.get('/reports/owners');
        },

        incidents(params = {}) {
            return API.get('/reports/incidents', params);
        },

        export(type) {
            window.open(`${API.baseUrl}/reports/export/${type}?token=${API.getToken()}`, '_blank');
        },
    },
};
