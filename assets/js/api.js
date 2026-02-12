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
            const contentType = response.headers.get('content-type') || '';

            let data = null;
            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                // например, nginx 413 отдаёт HTML
                const text = await response.text();
                data = { success: false, message: text ? 'Ошибка ответа сервера' : 'Ошибка запроса' };
            }

            if (!response.ok) {
                if (response.status === 401) {
                    this.clearToken();
                    window.location.reload();
                }
                if (response.status === 413) {
                    throw new Error('Файл слишком большой (413). Уменьшите размер или увеличьте лимит на сервере.');
                }
                throw new Error(data?.message || `Ошибка запроса (${response.status})`);
            }

            return data;
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    },

    /**
     * Скачать файл (blob) с авторизацией Bearer
     */
    async download(endpoint, params = {}, suggestedFilename = null) {
        const query = new URLSearchParams(params).toString();
        const url = this.baseUrl + endpoint + (query ? `?${query}` : '');

        const headers = {};
        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url, { method: 'GET', headers });
        const contentType = response.headers.get('content-type') || '';

        // Ошибка: обычно JSON
        if (!response.ok) {
            let message = `Ошибка запроса (${response.status})`;
            if (contentType.includes('application/json')) {
                try {
                    const data = await response.json();
                    message = data?.message || message;
                } catch (_) {}
            }
            if (response.status === 401) {
                this.clearToken();
                window.location.reload();
            }
            throw new Error(message);
        }

        // Сервер мог вернуть JSON с success=false (например, при ошибке)
        if (contentType.includes('application/json')) {
            const data = await response.json();
            throw new Error(data?.message || 'Ошибка выгрузки');
        }

        const blob = await response.blob();

        // filename из Content-Disposition
        let filename = suggestedFilename || 'export.csv';
        const cd = response.headers.get('content-disposition') || '';
        const match = cd.match(/filename\*?=(?:UTF-8''|")?([^\";]+)"?/i);
        if (match && match[1]) {
            try {
                filename = decodeURIComponent(match[1].trim());
            } catch (_) {
                filename = match[1].trim();
            }
        }

        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
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

        clones(params = {}) {
            return API.get('/wells/clones', params);
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

        existsNumber(number, exclude_id = null) {
            const params = { number };
            if (exclude_id !== null && exclude_id !== undefined && exclude_id !== '') {
                params.exclude_id = exclude_id;
            }
            return API.get('/wells/exists', params);
        },

        importTextPreview(text, delimiter = ';') {
            return API.post('/wells/import-text/preview', { text, delimiter });
        },

        importText(text, delimiter, mapping, coordinate_system = 'wgs84', options = {}) {
            return API.post('/wells/import-text', { text, delimiter, mapping, coordinate_system, ...options });
        },

        dismantle(id) {
            return API.post(`/wells/${id}/dismantle`, {});
        },
    },

    // ========================
    // Направления каналов
    // ========================

    channelDirections: {
        list(params = {}) {
            return API.get('/channel-directions', params);
        },

        stats(params = {}) {
            return API.get('/channel-directions/stats', params);
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

        ensureChannelCount(directionId, targetCount) {
            return API.post(`/channel-directions/${directionId}/channels/ensure`, { target_count: targetCount });
        },

        stuffWell(directionId, data) {
            return API.post(`/channel-directions/${directionId}/stuff-well`, data);
        },

        shortestPath(start_well_id, end_well_id, exclude_direction_ids = null) {
            const params = { start_well_id, end_well_id };
            const ex = Array.isArray(exclude_direction_ids) ? exclude_direction_ids : null;
            if (ex && ex.length) {
                params.exclude_direction_ids = ex.map(x => parseInt(x, 10)).filter(n => n > 0).join(',');
            }
            return API.get('/channel-directions/shortest-path', params);
        },

        geojsonByIds(ids = []) {
            const list = Array.isArray(ids) ? ids : [];
            return API.get('/channel-directions/geojson-by-ids', { ids: list.join(',') });
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

        stats(params = {}) {
            return API.get('/unified-cables/stats', params);
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

        existsNumber(number, exclude_id = null) {
            const params = { number };
            if (exclude_id !== null && exclude_id !== undefined && exclude_id !== '') {
                params.exclude_id = exclude_id;
            }
            return API.get('/unified-cables/exists', params);
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

        existsNumber(number, exclude_id = null) {
            const params = { number };
            if (exclude_id !== null && exclude_id !== undefined && exclude_id !== '') {
                params.exclude_id = exclude_id;
            }
            return API.get('/marker-posts/exists', params);
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

        documents(id) {
            return API.get(`/incidents/${id}/documents`);
        },

        uploadDocument(id, file, description = '') {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('description', description);
            return API.upload(`/incidents/${id}/documents`, formData);
        },

        deleteDocument(docId) {
            return API.delete(`/incidents/documents/${docId}`);
        },
    },

    // ========================
    // Группы
    // ========================

    groups: {
        list(params = {}) {
            return API.get('/groups', params);
        },

        byObject(type, objectId) {
            return API.get('/groups/by-object', { type, object_id: objectId });
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

        attachments(id) {
            return API.get(`/groups/${id}/attachments`);
        },

        uploadAttachment(id, file, description = '') {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('description', description);
            return API.upload(`/groups/${id}/attachments`, formData);
        },

        deleteAttachment(attId) {
            return API.delete(`/groups/attachments/${attId}`);
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
    // Собственники: персональные цвета (для легенды)
    // ========================

    owners: {
        colors() {
            return API.get('/owners/colors');
        },

        setColor(ownerId, color) {
            return API.put(`/owners/colors/${ownerId}`, { color });
        },

        resetColor(ownerId) {
            return API.delete(`/owners/colors/${ownerId}`);
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

        contracts(params = {}) {
            return API.get('/reports/contracts', params);
        },

        owners(params = {}) {
            return API.get('/reports/owners', params);
        },

        incidents(params = {}) {
            return API.get('/reports/incidents', params);
        },

        export(type, params = {}, delimiter = ';') {
            return API.download(`/reports/export/${type}`, { ...params, delimiter });
        },
    },

    // ========================
    // Настройки
    // ========================
    settings: {
        get() {
            return API.get('/settings');
        },
        update(data) {
            return API.put('/settings', data);
        }
    },

    // ========================
    // Администрирование: журнал действий
    // ========================
    auditLog: {
        list(params = {}) {
            return API.get('/admin/audit-log', params);
        }
    },

    // ========================
    // Администрирование: бэкапы БД
    // ========================
    dbBackups: {
        config() {
            return API.get('/admin/db-backups/config');
        },
        updateConfig(data) {
            return API.put('/admin/db-backups/config', data);
        },
        list() {
            return API.get('/admin/db-backups');
        },
        create() {
            return API.post('/admin/db-backups', {});
        },
        tick() {
            return API.post('/admin/db-backups/tick', {});
        },
        cronInfo() {
            return API.get('/admin/db-backups/cron');
        },
        cronInstall() {
            return API.post('/admin/db-backups/cron/install', {});
        },
        cronRemove() {
            return API.post('/admin/db-backups/cron/remove', {});
        },
        restore(id) {
            return API.post(`/admin/db-backups/${encodeURIComponent(id)}/restore`, {});
        },
    },
};
