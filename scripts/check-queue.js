#!/usr/bin/env node
/**
 * Script para verificar el estado de la cola BullMQ
 */

require('dotenv').config();
const { Queue } = require('bullmq');
const { getRedisConnectionOptions } = require('../src/redisClient');

async function main() {
  const jobId = process.argv[2];
  
  const queue = new Queue('ms:messages', {
    connection: getRedisConnectionOptions(),
  });

  try {
    if (jobId) {
      // Ver estado de un job específico
      const job = await queue.getJob(jobId);
      if (!job) {
        console.log(`❌ Job ${jobId} no encontrado`);
      } else {
        console.log(`\n📋 Job #${jobId}:`);
        console.log(`  Estado: ${await job.getState()}`);
        console.log(`  Usuario: ${job.data.userId}`);
        console.log(`  Total mensajes: ${job.data.contacts?.length || 0}`);
        console.log(`  Intentos: ${job.attemptsMade}/${job.opts.attempts}`);
        console.log(`  Creado: ${new Date(job.timestamp).toLocaleString()}`);
        if (job.processedOn) {
          console.log(`  Procesado: ${new Date(job.processedOn).toLocaleString()}`);
        }
        if (job.finishedOn) {
          console.log(`  Finalizado: ${new Date(job.finishedOn).toLocaleString()}`);
        }
      }
    }

    // Resumen de la cola
    console.log('\n📊 Estado de la cola:');
    const counts = await queue.getJobCounts();
    console.log(`  Esperando: ${counts.waiting}`);
    console.log(`  Activos: ${counts.active}`);
    console.log(`  Completados: ${counts.completed}`);
    console.log(`  Fallidos: ${counts.failed}`);
    console.log(`  Delayed: ${counts.delayed}`);

    // Mostrar jobs activos
    if (counts.active > 0) {
      console.log('\n🔄 Jobs activos:');
      const active = await queue.getActive();
      active.forEach(job => {
        console.log(`  - Job #${job.id} (userId: ${job.data.userId})`);
      });
    }

    // Mostrar jobs en espera
    if (counts.waiting > 0) {
      console.log('\n⏳ Primeros jobs en espera:');
      const waiting = await queue.getWaiting(0, 5);
      waiting.forEach((job, idx) => {
        console.log(`  ${idx + 1}. Job #${job.id} (userId: ${job.data.userId})`);
      });
    }

    // Mostrar jobs delayed
    if (counts.delayed > 0) {
      console.log('\n⏰ Jobs delayed:');
      const delayed = await queue.getDelayed(0, 10);
      delayed.forEach((job, idx) => {
        const delayUntil = new Date(job.timestamp + (job.opts.delay || 0));
        console.log(`  ${idx + 1}. Job #${job.id} (userId: ${job.data.userId}) - procesa a las ${delayUntil.toLocaleTimeString()}`);
      });
    }

    await queue.close();
    console.log('\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
