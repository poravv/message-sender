#!/bin/bash
# Script para instalar KEDA en el cluster de Kubernetes

set -e

echo "🚀 Instalando KEDA v2.12..."
echo ""

# Verificar si kubectl está disponible
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl no está instalado"
    exit 1
fi

# Verificar conexión al cluster
if ! kubectl cluster-info &> /dev/null; then
    echo "❌ No se puede conectar al cluster de Kubernetes"
    exit 1
fi

echo "✅ Conectado al cluster"
echo ""

# Instalar KEDA
echo "📦 Instalando KEDA..."
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.12.0/keda-2.12.0.yaml

echo ""
echo "⏳ Esperando a que KEDA esté listo..."
kubectl wait --for=condition=ready pod -l app=keda-operator -n keda --timeout=300s
kubectl wait --for=condition=ready pod -l app=keda-metrics-apiserver -n keda --timeout=300s

echo ""
echo "✅ KEDA instalado exitosamente"
echo ""

# Mostrar estado
echo "📊 Estado de KEDA:"
kubectl get pods -n keda

echo ""
echo "🎯 Ahora puedes aplicar el ScaledObject:"
echo "   kubectl apply -f k8s/keda-scaledobject.yaml"
echo ""
echo "📈 Monitorear escalado:"
echo "   kubectl get scaledobject -n sender"
echo "   kubectl describe scaledobject sender-backend-scaledobject -n sender"
