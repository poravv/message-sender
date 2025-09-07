CONFIGURACIÓN KEYCLOAK CLIENTE - message-sender-web
====================================================

1. Client ID: message-sender-web
2. Client Protocol: openid-connect
3. Access Type: public
4. Standard Flow Enabled: ON
5. Implicit Flow Enabled: OFF
6. Direct Access Grants Enabled: ON
7. Service Accounts Enabled: OFF

8. Valid Redirect URIs:
   - http://localhost:3009/*
   - http://localhost:3009/
   - https://your-production-domain.com/*

9. Web Origins:
   - http://localhost:3009
   - https://your-production-domain.com

10. Admin URL: (dejar vacío)

11. Base URL: http://localhost:3009

ROLES NECESARIOS:
================
- sender_api (debe estar asignado al usuario)

USUARIOS:
=========
- Crear o usar usuario existente
- Asignar el rol 'sender_api' al usuario