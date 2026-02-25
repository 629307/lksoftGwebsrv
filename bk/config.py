import os

class Config:
    # Legacy (bk) app config. Do not ship to production.
    # Do not hardcode secrets in repository.
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'CHANGE_ME'
    
    # Database
    DB_HOST = os.environ.get('DB_HOST', 'localhost')
    DB_PORT = os.environ.get('DB_PORT', '5432')
    DB_NAME = os.environ.get('DB_NAME', 'lksoftgwebsrv')
    DB_USER = os.environ.get('DB_USER', 'lksoftgwebsrv')
    DB_PASSWORD = os.environ.get('DB_PASSWORD', '')
    
    DATABASE_URL = f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    
    # Upload settings
    UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB max file size
    ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
    
    # GIS settings
    SRID_WGS84 = 4326
    SRID_MSK86_ZONE4 = 2502  # МСК-86 зона 4 (приблизительный EPSG код)
    
    # Default admin credentials
    DEFAULT_ADMIN_LOGIN = 'root'
    DEFAULT_ADMIN_PASSWORD = os.environ.get('DEFAULT_ADMIN_PASSWORD', 'CHANGE_ME')
