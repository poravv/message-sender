# Optimización de Recursos - KEDA Auto-Scaling

## 📊 Configuración Actual

### Recursos del Pod
- **CPU Request**: 100m (0.1 cores)
- **CPU Limit**: 300m (0.3 cores)
- **Memory Request**: 256Mi
- **Memory Limit**: 512Mi
- **Ephemeral Storage**: 512Mi - 1Gi

### Auto-Scaling
- **Min Replicas**: 0 (se duerme cuando no hay tráfico)
- **Max Replicas**: 2
- **Cooldown**: 5 minutos sin tráfico para escalar a 0
- **Scale Up**: Activación inmediata en tráfico

## 🎯 Triggers de Escalado

1. **CPU > 70%** → Escala UP
2. **Memory > 80%** → Escala UP
3. **HTTP Requests > 5/seg** → Escala UP
4. **Sin tráfico por 5 min** → Escala a 0

## 🚀 Instalación de KEDA (Opcional)

Si quieres usar scale-to-zero con KEDA:

```bash
# Instalar KEDA en el cluster
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.12.0/keda-2.12.0.yaml

# Verificar instalación
kubectl get pods -n keda

# Aplicar ScaledObject
kubectl apply -f k8s/keda-scaledobject.yaml
```

## 📈 Monitoreo

```bash
# Ver estado del HPA
kubectl get hpa -n sender

# Ver eventos de escalado
kubectl describe hpa sender-backend-hpa -n sender

# Ver réplicas actuales
kubectl get deployment sender-backend -n sender

# Si KEDA está instalado
kubectl get scaledobject -n sender
kubectl describe scaledobject sender-backend-scaledobject -n sender
```

## 💰 Ahorro de Recursos

### Sin Tráfico (0 réplicas)
- **CPU**: 0m
- **Memory**: 0Mi
- **Ahorro**: 100%

### Con Tráfico Bajo (1 réplica)
- **CPU**: ~50-100m
- **Memory**: ~200-300Mi
- **Ahorro**: ~80% vs configuración anterior (500m CPU, 1.5Gi RAM)

### Con Tráfico Alto (2 réplicas)
- **CPU**: ~200m
- **Memory**: ~500Mi
- **Ahorro**: ~60% vs configuración anterior

## ⚙️ Configuración Manual

Si no usas KEDA, el HPA tradicional mantiene **mínimo 1 réplica**.

Para forzar 0 réplicas manualmente:
```bash
kubectl scale deployment sender-backend -n sender --replicas=0
```

Para reactivar:
```bash
kubectl scale deployment sender-backend -n sender --replicas=1
```

## 🔧 Troubleshooting

### El pod no escala a 0
1. Verificar que KEDA esté instalado: `kubectl get pods -n keda`
2. Revisar métricas: `kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes`
3. Ver logs de KEDA: `kubectl logs -n keda -l app=keda-operator`

### Tarda mucho en despertar
- Kubernetes puede tardar 10-30 segundos en levantar el pod desde 0
- El usuario verá un timeout inicial, luego funcionará normal
- Considera mantener minReplicas: 1 si necesitas respuesta inmediata

## 📝 Notas

- **KEDA es opcional**: Si no está instalado, usa HPA tradicional con min=1
- **Cold Start**: ~15-30 seg para levantar desde 0 réplicas
- **Redis/MinIO**: No afectados, siempre activos
- **Sesiones WhatsApp**: Persisten en Redis, se reconectan automáticamente
