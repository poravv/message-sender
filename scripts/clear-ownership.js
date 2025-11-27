#!/usr/bin/env node
/**
 * Script para limpiar ownership de Redis en desarrollo
 * Uso: node scripts/clear-ownership.js <userId>
 */

// Cargar variables de entorno
require('dotenv').config();

const { clearOwner, forceAcquireOwner, getOwner } = require('../src/owner');
const { getRedis } = require('../src/redisClient');

async function main() {
  const userId = process.argv[2];

  if (!userId) {
    console.error('❌ Error: Debes proporcionar un userId');
    console.log('\nUso: node scripts/clear-ownership.js <userId>');
    console.log('Ejemplo: node scripts/clear-ownership.js 93adea96-833f-4231-8b57-97dc0a113011');
    process.exit(1);
  }

  try {
    // Verificar owner actual
    const currentOwner = await getOwner(userId);
    console.log(`\n📋 Owner actual para userId=${userId}:`, currentOwner || 'ninguno');

    // Limpiar ownership
    console.log('\n🧹 Limpiando ownership...');
    await clearOwner(userId);
    console.log('✅ Ownership eliminado correctamente');

    // Verificar que se eliminó
    const afterClear = await getOwner(userId);
    console.log('📋 Owner después de limpiar:', afterClear || 'ninguno');

    // Cerrar conexión Redis
    const redis = getRedis();
    await redis.quit();
    console.log('\n✨ Proceso completado\n');
  } catch (error) {
    console.error('\n❌ Error al limpiar ownership:', error.message);
    process.exit(1);
  }
}

main();
