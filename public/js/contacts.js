/**
 * Contacts - Contact Management
 */

// Load contacts
async function loadContacts() {
  try {
    const search = document.getElementById('contactSearchInput')?.value || '';
    const group = document.getElementById('contactGroupFilter')?.value || '';
    
    const res = await authFetch(`/contacts${buildQuery({ search, group, page: 1, pageSize: 200 })}`);
    const data = await res.json();
    
    renderContactsTable(data.items || []);
    updateContactsCount(data.total || data.items?.length || 0);
    
  } catch (error) {
    console.error('Error loading contacts:', error);
  }
}

// Render contacts table
function renderContactsTable(items) {
  const tbody = document.getElementById('contactsTableBody');
  const empty = document.getElementById('contactsEmpty');
  
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  if (!items.length) {
    if (empty) empty.classList.remove('d-none');
    return;
  }
  
  if (empty) empty.classList.add('d-none');
  
  items.forEach(c => {
    const tr = document.createElement('tr');
    const sourceBadge = c.source === 'csv' 
      ? '<span class="badge bg-info">CSV</span>' 
      : '<span class="badge bg-secondary">Manual</span>';
    
    tr.innerHTML = `
      <td><code>${c.phone || '—'}</code></td>
      <td>${c.nombre || '—'}</td>
      <td>${c.sustantivo || '—'}</td>
      <td>${c.grupo || '<span class="text-muted">—</span>'}</td>
      <td>${sourceBadge}</td>
      <td class="actions">
        <button class="btn btn-sm btn-outline-primary" onclick="editContact('${c.id}')">
          <i class="bi bi-pencil"></i>
        </button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteContact('${c.id}')">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Update contacts count badge
function updateContactsCount(count) {
  const badge = document.getElementById('contactsCount');
  if (badge) {
    badge.textContent = `${count} contacto${count !== 1 ? 's' : ''}`;
  }
}

// Add contact
async function addContact(e) {
  e.preventDefault();
  
  const phone = document.getElementById('contactPhone')?.value?.trim();
  const nombre = document.getElementById('contactNombre')?.value?.trim();
  const sustantivo = document.getElementById('contactSustantivo')?.value?.trim();
  const grupo = document.getElementById('contactGrupo')?.value?.trim();
  
  if (!phone) {
    showAlert('El número es requerido', 'warning');
    return;
  }
  
  try {
    const res = await authFetch('/contacts', {
      method: 'POST',
      body: JSON.stringify({ phone, nombre, sustantivo, grupo })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Error al agregar contacto');
    }
    
    showAlert('Contacto agregado', 'success');
    
    // Clear form
    document.getElementById('contactPhone').value = '';
    document.getElementById('contactNombre').value = '';
    document.getElementById('contactSustantivo').value = '';
    document.getElementById('contactGrupo').value = '';
    
    loadContacts();
    
  } catch (error) {
    showAlert(error.message, 'danger');
  }
}

// Edit contact
async function editContact(id) {
  try {
    const res = await authFetch(`/contacts/${id}`);
    const contact = await res.json();
    
    const phone = prompt('Número:', contact.phone || '');
    if (phone === null) return;
    
    const nombre = prompt('Nombre:', contact.nombre || '');
    const sustantivo = prompt('Tratamiento:', contact.sustantivo || '');
    const grupo = prompt('Grupo:', contact.grupo || '');
    
    const updateRes = await authFetch(`/contacts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ phone, nombre, sustantivo, grupo })
    });
    
    if (!updateRes.ok) {
      throw new Error('Error al actualizar');
    }
    
    showAlert('Contacto actualizado', 'success');
    loadContacts();
    
  } catch (error) {
    showAlert(error.message, 'danger');
  }
}

// Delete contact
async function deleteContact(id) {
  if (!confirm('¿Eliminar este contacto?')) return;
  
  try {
    const res = await authFetch(`/contacts/${id}`, { method: 'DELETE' });
    
    if (!res.ok) {
      throw new Error('Error al eliminar');
    }
    
    showAlert('Contacto eliminado', 'success');
    loadContacts();
    
  } catch (error) {
    showAlert(error.message, 'danger');
  }
}

// Setup contacts
function setupContacts() {
  // Add form
  const form = document.getElementById('addContactForm');
  if (form) {
    form.addEventListener('submit', addContact);
  }
  
  // Search/filter
  const searchBtn = document.getElementById('searchContactsBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', loadContacts);
  }
  
  // Search on enter
  const searchInput = document.getElementById('contactSearchInput');
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadContacts();
      }
    });
  }
  
  // Refresh button
  const refreshBtn = document.getElementById('refreshContactsBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadContacts);
  }

  // CSV Import
  setupCsvImport();
}

// Setup CSV Import
function setupCsvImport() {
  const dropZone = document.getElementById('csvDropZone');
  const fileInput = document.getElementById('csvFileInput');
  
  if (!dropZone || !fileInput) return;
  
  // Drag & Drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      importCsvFile(files[0]);
    }
  });
  
  // File input change - auto import
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importCsvFile(e.target.files[0]);
    }
  });
}

// Import CSV file directly
async function importCsvFile(file) {
  const validTypes = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];
  const validExt = file.name.endsWith('.csv') || file.name.endsWith('.txt');
  
  if (!validTypes.includes(file.type) && !validExt) {
    showAlert('Por favor selecciona un archivo CSV o TXT', 'warning');
    return;
  }
  
  const uploadContent = document.getElementById('csvUploadContent');
  const progress = document.getElementById('importProgress');
  const progressText = document.getElementById('importProgressText');
  const fileInput = document.getElementById('csvFileInput');
  
  // Show loading
  if (uploadContent) uploadContent.classList.add('d-none');
  if (progress) progress.classList.remove('d-none');
  if (progressText) progressText.textContent = `Importando ${file.name}...`;
  
  try {
    const formData = new FormData();
    formData.append('csvFile', file);
    
    const res = await authFetch('/contacts/import', {
      method: 'POST',
      body: formData
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Error al importar contactos');
    }
    
    showAlert(`Importados: ${data.imported} nuevos, ${data.updated} actualizados (Total: ${data.total})`, 'success');
    loadContacts();
    
  } catch (error) {
    showAlert(error.message, 'danger');
  } finally {
    // Reset UI
    if (uploadContent) uploadContent.classList.remove('d-none');
    if (progress) progress.classList.add('d-none');
    if (fileInput) fileInput.value = '';
  }
}

// Initialize Contacts module
function initContacts() {
  setupContacts();
}

// Global exports
window.loadContacts = loadContacts;
window.initContacts = initContacts;
window.editContact = editContact;
window.deleteContact = deleteContact;
