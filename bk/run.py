#!/usr/bin/env python3
"""
ИГС Portal - Development Server Runner
"""

import os
import sys

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app, init_db

if __name__ == '__main__':
    print("=" * 50)
    print("ИГС Web Portal")
    print("=" * 50)
    print(f"Database: {app.config.get('DB_HOST')}:{app.config.get('DB_PORT')}/{app.config.get('DB_NAME')}")
    print()
    
    # Initialize database
    try:
        print("Initializing database...")
        init_db()
        print("Database initialized successfully!")
    except Exception as e:
        print(f"Warning: Database initialization failed: {e}")
        print("Make sure PostgreSQL is running and accessible.")
    
    print()
    print("Starting development server...")
    print("Access the portal at: http://localhost:5000")
    print("Default admin credentials: set during installation (do not hardcode in repo).")
    print()
    print("Press Ctrl+C to stop")
    print("=" * 50)
    
    app.run(host='0.0.0.0', port=5000, debug=True)
