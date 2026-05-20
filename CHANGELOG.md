# Changelog funcional — message-sender

Resumen de cambios por área funcional. Sin detalle de código.

---

## Autenticación y usuarios

- Migración completa de Keycloak → Firebase Auth
- Login y registro con Google
- Trial automático de 15 días al crear cuenta
- Perfil de usuario en Firestore con plan, rol y fecha de expiración
- Sistema de sesión única por usuario
- Eliminación del whitelist de teléfonos autorizados (desbloqueó acceso a todos los usuarios)

---

## Planes y límites

- Sistema de planes: `trial`, `basico`, `profesional`, `premium`, `enterprise`
- Control de envíos mensuales por plan
- Control de contactos, plantillas y features por plan
- Límites actuales:

| Plan | Mensajes/mes | Contactos | Plantillas |
|---|---|---|---|
| Trial (15 días) | 9.000 (~300/día) | 100 | 10 |
| Básico | 12.000 | 1.000 | 20 |
| Profesional | 30.000 | Ilimitado | Ilimitado |
| Premium | 60.000 | Ilimitado | Ilimitado |
| Enterprise | Ilimitado | Ilimitado | Ilimitado |

- Gating de features booleanas (chatbot, inbox, API) según plan
- Trial incluye: chatbot, chatbot AI, inbox y campañas

---

## Envío de mensajes

- Envío masivo con CSV de contactos
- Soporte de audio (AAC, conversión automática con FFmpeg)
- Soporte de imágenes
- Rate limiting: 15 mensajes/minuto con jitter anti-spam
- Cola BullMQ con reintentos automáticos
- Tracking de progreso por campaña en tiempo real

---

## WhatsApp / Conexión

- Integración con Baileys (WebSocket)
- QR auto-refresh cada 18 segundos para evitar QR vencidos
- Reconexión automática con watchdog keepalive
- Auth state persistido en Redis (soporte multi-pod)
- Fix para rechazo 401 de Android usando Desktop companion type
- Fix para login usando plataforma MACOS (parche Baileys)
- No limpia auth de Redis en desconexiones por conflicto de sesión

---

## Chatbot

- Motor de flujos con nodos y árbol visual
- Palabras clave de activación y desactivación configurables
- Nodo de inicio configurable
- Mensajes de fallback, salida y bienvenida configurables
- Opción "Salir" automática en todos los menús
- Modo AI completo con system prompt de entrenamiento
- Integración con OpenAI y otras APIs (clave encriptada AES-256)
- Optimización de tokens y auto-expiración de sesiones
- Límite de 50 respuestas por conversación en modo AI
- Pausa del bot por conversación desde el inbox
- Guardianes de seguridad obligatorios en respuestas AI
- Resolución de LID de WhatsApp a número real de teléfono

---

## Inbox (mensajes entrantes)

- Registro de todos los mensajes entrantes
- Estado leído / no leído por conversación
- Respuesta directa desde el inbox
- Posibilidad de pausar el chatbot por conversación

---

## Campañas

- Historial de campañas con estado y progreso
- Registro de respuestas por campaña
- Vista de destinatarios y resultados individuales

---

## Dashboard

- Widget de cuota del plan (mensajes usados vs. límite mensual)
- Analytics de actividad mensual

---

## UI / Frontend

- Shell v2: sidebar + topbar como layout principal
- Integración de Tailwind CSS v3
- Guía de estilos shadcn-style
- Vistas v2 para contactos, campañas y planes
- Alertas ancladas a la derecha
- Diseño responsive: mobile, tablet y desktop
- Dropdown de menú propio en topbar mobile

---

## Infraestructura

- Docker multi-stage (node:20-bullseye-slim + ffmpeg)
- Kubernetes: Deployment, HPA, KEDA scale-to-zero, Ingress con TLS
- Redis interno en K8s sin contraseña (`redis-sender`)
- CI/CD: push a `main` → build → GHCR → kubectl apply
- PostgreSQL en StatefulSet con pool de conexiones y retry automático
- Secrets de Firebase y chatbot encriptados en K8s
