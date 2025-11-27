#!/usr/bin/env node
/**
 * Script para eliminar un job específico
 */

require('dotenv').config();
const { Queue } = require('bullmq');
const { getRedisConnectionOptions } = require('../src/redisClient');

async function main() {
  const jobId = process.argv[2];
  
  if (!jobId) {
    console.error('❌ Debes proporcionar un jobId');
    console.log('Uso: node scripts/remove-job.js <jobId>');
    process.exit(1);
  }

  const queue = new Queue('ms:messages', {
    connection: getRedisConnectionOptions(),
  });

  try {
    const job = await queue.getJob(jobId);
    
    if (!job) {
      console.log(`❌ Job ${jobId} no encontrado`);
      await queue.close();
      process.exit(1);
    }

    console.log(`\n📋 Job #${jobId}:`);
    console.log(`  Usuario: ${job.data.userId}`);
    console.log(`  Estado: ${await job.getState()}`);
    console.log(`  Intentos: ${job.attemptsMade}`);

    console.log('\n🗑️  Eliminando job...');
    await job.remove();
    console.log('✅ Job eliminado correctamente\n');

    await queue.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
