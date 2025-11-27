#!/usr/bin/env node
/**
 * Script para ver logs de error de un job
 */

require('dotenv').config();
const { Queue } = require('bullmq');
const { getRedisConnectionOptions } = require('../src/redisClient');

async function main() {
  const jobId = process.argv[2];
  
  if (!jobId) {
    console.error('❌ Debes proporcionar un jobId');
    console.log('Uso: node scripts/job-logs.js <jobId>');
    process.exit(1);
  }

  const queue = new Queue('ms:messages', {
    connection: getRedisConnectionOptions(),
  });

  try {
    const job = await queue.getJob(jobId);
    
    if (!job) {
      console.log(`❌ Job ${jobId} no encontrado`);
      process.exit(1);
    }

    console.log(`\n📋 Job #${jobId} - ${job.data.userId}`);
    console.log(`Estado: ${await job.getState()}`);
    console.log(`Intentos: ${job.attemptsMade}/${job.opts.attempts}`);
    
    if (job.stacktrace && job.stacktrace.length > 0) {
      console.log('\n❌ Errores:');
      job.stacktrace.slice(-5).forEach((err, idx) => {
        console.log(`\n${job.stacktrace.length - 4 + idx}. ${err}`);
      });
    }
    
    if (job.failedReason) {
      console.log('\n❌ Última razón de fallo:');
      console.log(job.failedReason);
    }

    console.log('\n📦 Data del job:');
    console.log(JSON.stringify(job.data, null, 2));

    await queue.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
