---
name: k8s-deploy
description: 'Kubernetes deployment y CI/CD. Usar cuando: modificar manifiestos k8s, debugging de pods, configurar HPA/KEDA scaling, troubleshoot deployments, actualizar configmaps/secrets, GitHub Actions workflows, docker builds, o cualquier tarea de infraestructura y deployment.'
---

# Kubernetes Deployment

## Cuándo Usar

- Modificar manifiestos de Kubernetes
- Debugging de pods que no inician o crashean
- Configurar auto-scaling (HPA, KEDA)
- Actualizar ConfigMaps o Secrets
- Modificar GitHub Actions workflows
- Optimizar Docker builds
- Configurar Ingress y certificados

## Estructura de Manifiestos

```
k8s/
├── namespace.yaml          # Namespace 'sender'
├── backend-deployment.yaml # Deployment principal
├── configmap.yaml          # Variables de entorno
├── ingress.yaml            # Nginx Ingress + TLS
├── keda-scaledobject.yaml  # Auto-scaling basado en cola
├── pdb.yaml                # Pod Disruption Budget
└── postgresql.yaml         # PostgreSQL StatefulSet
```

## Deployment Actual

```yaml
# backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sender-backend
  namespace: sender
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  template:
    spec:
      terminationGracePeriodSeconds: 90
      containers:
      - name: sender-backend
        image: ghcr.io/poravv/message-sender:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 3010
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "300m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3010
          initialDelaySeconds: 30
          periodSeconds: 15
        readinessProbe:
          httpGet:
            path: /health
            port: 3010
          initialDelaySeconds: 15
          periodSeconds: 10
```

## KEDA Scaling (Cola-based)

```yaml
# keda-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sender-backend-scaler
  namespace: sender
spec:
  scaleTargetRef:
    name: sender-backend
  minReplicaCount: 1
  maxReplicaCount: 3
  triggers:
  - type: redis
    metadata:
      address: redis.mindtechpy.net:6379
      listName: bull:whatsapp-messages:wait
      listLength: "10"    # Scale up cuando >10 jobs en espera
```

## GitHub Actions Workflow

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Login to GHCR
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    
    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: .
        push: true
        tags: ghcr.io/${{ github.repository }}:latest
        cache-from: type=gha
        cache-to: type=gha,mode=max
    
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
    - name: Deploy to K8s
      run: |
        kubectl rollout restart deployment/sender-backend -n sender
```

## Dockerfile Optimizado

```dockerfile
# Multi-stage build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
EXPOSE 3010
CMD ["node", "app.js"]
```

## Comandos Útiles

### Pods y Logs
```bash
# Ver pods
kubectl get pods -n sender

# Logs del pod
kubectl logs -f deployment/sender-backend -n sender

# Logs con timestamps
kubectl logs --timestamps -f pod/sender-backend-xxxxx -n sender

# Entrar al pod
kubectl exec -it deployment/sender-backend -n sender -- sh
```

### Deployment
```bash
# Rollout restart (nueva imagen)
kubectl rollout restart deployment/sender-backend -n sender

# Ver estado del rollout
kubectl rollout status deployment/sender-backend -n sender

# Rollback
kubectl rollout undo deployment/sender-backend -n sender
```

### ConfigMap y Secrets
```bash
# Ver configmap
kubectl get configmap backend-config -n sender -o yaml

# Editar configmap
kubectl edit configmap backend-config -n sender

# Crear secret
kubectl create secret generic backend-env-secrets \
  --from-literal=REDIS_PASSWORD=xxx \
  --from-literal=POSTGRES_PASSWORD=xxx \
  -n sender
```

### Debugging
```bash
# Describe pod (ver eventos)
kubectl describe pod sender-backend-xxxxx -n sender

# Ver eventos del namespace
kubectl get events -n sender --sort-by='.lastTimestamp'

# Port forward para testing local
kubectl port-forward deployment/sender-backend 3010:3010 -n sender
```

## Troubleshooting

### Pod en CrashLoopBackOff
```bash
# Ver logs del crash previo
kubectl logs pod/sender-backend-xxxxx -n sender --previous

# Verificar recursos
kubectl top pod -n sender

# Verificar env vars
kubectl exec deployment/sender-backend -n sender -- printenv | grep -E 'REDIS|POSTGRES'
```

### ImagePullBackOff
```bash
# Verificar secret de GHCR
kubectl get secret ghcr-secret -n sender

# Recrear si expiró
kubectl delete secret ghcr-secret -n sender
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=xxx \
  --docker-password=xxx \
  -n sender
```

### Pod no pasa readinessProbe
```bash
# Verificar que /health responde
kubectl exec deployment/sender-backend -n sender -- wget -qO- http://localhost:3010/health

# Revisar logs para errores de startup
kubectl logs deployment/sender-backend -n sender | head -50
```

## Archivos del Proyecto

- [backend-deployment.yaml](../../k8s/backend-deployment.yaml) - Deployment principal
- [configmap.yaml](../../k8s/configmap.yaml) - Variables de entorno
- [ingress.yaml](../../k8s/ingress.yaml) - Routing y TLS
- [keda-scaledobject.yaml](../../k8s/keda-scaledobject.yaml) - Auto-scaling
- [pdb.yaml](../../k8s/pdb.yaml) - Pod Disruption Budget
- [Dockerfile](../../Dockerfile) - Build de imagen
- [docker-compose.yml](../../docker-compose.yml) - Dev local
