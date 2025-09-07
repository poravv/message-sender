#!/usr/bin/env node

const { convertAudioToOpus } = require('./src/media');
const fs = require('fs');
const path = require('path');

async function testAudioConversion() {
  console.log('🎵 Iniciando prueba de conversión de audio...');
  
  // Verificar si existe algún archivo de audio en uploads
  const uploadsDir = './uploads';
  if (!fs.existsSync(uploadsDir)) {
    console.error('❌ Directorio uploads no existe');
    return;
  }
  
  const files = fs.readdirSync(uploadsDir);
  const audioFiles = files.filter(f => 
    f.match(/\.(mp3|wav|ogg|m4a|aac|webm)$/i)
  );
  
  console.log('📂 Archivos encontrados:', files);
  console.log('🎵 Archivos de audio:', audioFiles);
  
  if (audioFiles.length === 0) {
    console.log('⚠️  No se encontraron archivos de audio en uploads/');
    return;
  }
  
  const testFile = path.join(uploadsDir, audioFiles[0]);
  console.log(`📁 Archivo de prueba: ${testFile}`);
  
  try {
    const converted = await convertAudioToOpus(testFile, 'test-user');
    console.log(`✅ Conversión exitosa: ${converted}`);
    
    // Verificar el archivo convertido
    if (fs.existsSync(converted)) {
      const stats = fs.statSync(converted);
      console.log(`📊 Tamaño del archivo convertido: ${stats.size} bytes`);
      console.log(`📅 Fecha de creación: ${stats.birthtime}`);
      
      // Limpiar archivo de prueba
      fs.unlinkSync(converted);
      console.log('🧹 Archivo de prueba eliminado');
    }
    
  } catch (error) {
    console.error('❌ Error en conversión:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
  testAudioConversion().catch(console.error);
}

module.exports = { testAudioConversion };