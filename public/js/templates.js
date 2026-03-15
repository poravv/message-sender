/**
 * Templates - Message Template Management
 */

var templatesData = [];
var templateEditMode = false;
var templateCategories = [];

// ========== Load Templates ==========
async function loadTemplates(category) {
  try {
    var url = '/templates';
    if (category) {
      url += '?category=' + encodeURIComponent(category);
    }

    var res = await authFetch(url);
    if (!res || !res.ok) {
      showAlert('Error al cargar plantillas', 'danger');
      return;
    }

    var data = await res.json();
    templatesData = data.templates || [];

    renderTemplatesList();
    updateCategoryFilter();
    updateTemplatesEmpty();
  } catch (e) {
    console.error('Error loading templates:', e);
    showAlert('Error al cargar plantillas', 'danger');
  }
}

// ========== Render Templates List ==========
function renderTemplatesList() {
  var container = document.getElementById('templatesList');
  if (!container) return;

  container.innerHTML = '';

  if (templatesData.length === 0) return;

  templatesData.forEach(function(template) {
    container.appendChild(renderTemplateCard(template));
  });
}

// ========== Render Single Template Card ==========
function renderTemplateCard(template) {
  var card = document.createElement('div');
  card.className = 'template-card';
  card.dataset.id = template.id;

  var preview = template.content || '';
  var truncated = preview.length > 120 ? preview.substring(0, 120) + '...' : preview;

  var categoryBadge = '';
  if (template.category) {
    categoryBadge = '<span class="template-category-badge">' + escapeHtml(template.category) + '</span>';
  }

  var variableTags = '';
  if (template.variables && template.variables.length > 0) {
    variableTags = '<div class="template-card-variables">';
    template.variables.forEach(function(v) {
      variableTags += '<span class="template-var-tag">' + escapeHtml(v) + '</span>';
    });
    variableTags += '</div>';
  }

  card.innerHTML =
    '<div class="template-card-header">' +
      '<h4 class="template-card-name">' + escapeHtml(template.name) + '</h4>' +
      categoryBadge +
    '</div>' +
    '<div class="template-card-preview">' + escapeHtml(truncated) + '</div>' +
    variableTags +
    '<div class="template-card-footer">' +
      '<span class="template-card-date">' + formatRelativeDate(template.updated_at) + '</span>' +
      '<div class="template-card-actions">' +
        '<button class="template-action-btn template-use-btn" title="Usar en mensaje" data-id="' + template.id + '">' +
          '<i class="bi bi-send"></i> Usar' +
        '</button>' +
        '<button class="template-action-btn template-edit-btn" title="Editar" data-id="' + template.id + '">' +
          '<i class="bi bi-pencil"></i>' +
        '</button>' +
        '<button class="template-action-btn template-delete-btn" title="Eliminar" data-id="' + template.id + '">' +
          '<i class="bi bi-trash3"></i>' +
        '</button>' +
      '</div>' +
    '</div>';

  // Event listeners
  card.querySelector('.template-use-btn').addEventListener('click', function() {
    useTemplate(template.id);
  });
  card.querySelector('.template-edit-btn').addEventListener('click', function() {
    editTemplate(template.id);
  });
  card.querySelector('.template-delete-btn').addEventListener('click', function() {
    deleteTemplate(template.id);
  });

  return card;
}

// ========== Save Template ==========
async function saveTemplate() {
  var nameInput = document.getElementById('templateName');
  var contentInput = document.getElementById('templateContent');
  var categoryInput = document.getElementById('templateCategory');
  var editIdInput = document.getElementById('templateEditId');

  var name = (nameInput.value || '').trim();
  var content = (contentInput.value || '').trim();
  var category = (categoryInput.value || '').trim();

  if (!name) {
    showAlert('Ingresa un nombre para la plantilla', 'warning');
    nameInput.focus();
    return;
  }

  if (!content) {
    showAlert('Ingresa el contenido del mensaje', 'warning');
    contentInput.focus();
    return;
  }

  // Extract variables from content
  var varRegex = /\{(\w+)\}/g;
  var variables = [];
  var match;
  while ((match = varRegex.exec(content)) !== null) {
    var varName = '{' + match[1] + '}';
    if (variables.indexOf(varName) === -1) {
      variables.push(varName);
    }
  }

  var body = {
    name: name,
    content: content,
    category: category || null,
    variables: variables.length > 0 ? variables : null
  };

  var editId = editIdInput.value;
  var url = editId ? '/templates/' + editId : '/templates';
  var method = editId ? 'PUT' : 'POST';

  try {
    var saveBtn = document.getElementById('saveTemplateBtn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Guardando...';

    var res = await authFetch(url, {
      method: method,
      body: JSON.stringify(body)
    });

    if (!res || !res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      showAlert(errData.error || 'Error al guardar plantilla', 'danger');
      return;
    }

    showAlert(editId ? 'Plantilla actualizada' : 'Plantilla creada', 'success');
    clearTemplateForm();
    await loadTemplates();

    // Also refresh the saved template dropdown in the send tab
    if (typeof loadSavedTemplates === 'function') {
      loadSavedTemplates();
    }
  } catch (e) {
    console.error('Error saving template:', e);
    showAlert('Error al guardar plantilla', 'danger');
  } finally {
    var saveBtn2 = document.getElementById('saveTemplateBtn');
    if (saveBtn2) {
      saveBtn2.disabled = false;
      saveBtn2.innerHTML = '<i class="bi bi-save"></i> Guardar Plantilla';
    }
  }
}

// ========== Edit Template ==========
function editTemplate(id) {
  var template = templatesData.find(function(t) { return t.id === id; });
  if (!template) return;

  document.getElementById('templateEditId').value = template.id;
  document.getElementById('templateName').value = template.name || '';
  document.getElementById('templateCategory').value = template.category || '';
  document.getElementById('templateContent').value = template.content || '';

  var title = document.getElementById('templateFormTitle');
  if (title) title.textContent = 'Editar Plantilla';

  var cancelBtn = document.getElementById('cancelEditTemplateBtn');
  if (cancelBtn) cancelBtn.classList.remove('d-none');

  templateEditMode = true;

  // Update preview
  updateTemplatePreview();

  // Update char count
  updateCharCount();

  // Scroll to form
  document.getElementById('templateName').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('templateName').focus();
}

// ========== Delete Template ==========
async function deleteTemplate(id) {
  var template = templatesData.find(function(t) { return t.id === id; });
  var name = template ? template.name : 'esta plantilla';

  if (!confirm('Eliminar "' + name + '"? Esta accion no se puede deshacer.')) {
    return;
  }

  try {
    var res = await authFetch('/templates/' + id, { method: 'DELETE' });

    if (!res || !res.ok) {
      showAlert('Error al eliminar plantilla', 'danger');
      return;
    }

    showAlert('Plantilla eliminada', 'success');
    await loadTemplates();

    // Refresh send tab dropdown
    if (typeof loadSavedTemplates === 'function') {
      loadSavedTemplates();
    }
  } catch (e) {
    console.error('Error deleting template:', e);
    showAlert('Error al eliminar plantilla', 'danger');
  }
}

// ========== Use Template (navigate to send tab) ==========
function useTemplate(id) {
  var template = templatesData.find(function(t) { return t.id === id; });
  if (!template) return;

  // Navigate to send tab
  showTab('send');

  // Pre-fill the message textarea
  setTimeout(function() {
    var textarea = document.getElementById('message1');
    if (textarea) {
      textarea.value = template.content || '';
      textarea.dispatchEvent(new Event('input'));
      textarea.focus();
    }
  }, 100);
}

// ========== Clear Template Form ==========
function clearTemplateForm() {
  document.getElementById('templateEditId').value = '';
  document.getElementById('templateName').value = '';
  document.getElementById('templateCategory').value = '';
  document.getElementById('templateContent').value = '';

  var title = document.getElementById('templateFormTitle');
  if (title) title.textContent = 'Nueva Plantilla';

  var cancelBtn = document.getElementById('cancelEditTemplateBtn');
  if (cancelBtn) cancelBtn.classList.add('d-none');

  templateEditMode = false;

  updateTemplatePreview();
  updateCharCount();
}

// ========== Update Category Filter ==========
function updateCategoryFilter() {
  var select = document.getElementById('templateCategoryFilter');
  if (!select) return;

  // Collect unique categories
  var cats = [];
  templatesData.forEach(function(t) {
    if (t.category && cats.indexOf(t.category) === -1) {
      cats.push(t.category);
    }
  });

  cats.sort();
  templateCategories = cats;

  // Keep current selection
  var current = select.value;

  // Clear all except first option
  while (select.options.length > 1) {
    select.remove(1);
  }

  cats.forEach(function(cat) {
    var opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });

  // Restore selection
  if (current && cats.indexOf(current) !== -1) {
    select.value = current;
  }
}

// ========== Update Empty State ==========
function updateTemplatesEmpty() {
  var list = document.getElementById('templatesList');
  var empty = document.getElementById('templatesEmpty');
  if (!list || !empty) return;

  if (templatesData.length === 0) {
    list.classList.add('d-none');
    empty.classList.remove('d-none');
  } else {
    list.classList.remove('d-none');
    empty.classList.add('d-none');
  }
}

// ========== Setup Template Preview ==========
function setupTemplatePreview() {
  var textarea = document.getElementById('templateContent');
  if (!textarea) return;

  textarea.addEventListener('input', function() {
    updateTemplatePreview();
    updateCharCount();
  });
}

function updateTemplatePreview() {
  var textarea = document.getElementById('templateContent');
  var preview = document.getElementById('templatePreview');
  if (!textarea || !preview) return;

  var content = textarea.value || '';

  if (!content.trim()) {
    preview.innerHTML = '<span class="template-preview-placeholder">La vista previa aparecera aqui...</span>';
    return;
  }

  // Replace variables with example values
  var exampleValues = {
    '{nombre}': 'Juan',
    '{tratamiento}': 'Sr.',
    '{grupo}': 'Ventas'
  };

  var rendered = escapeHtml(content);
  Object.keys(exampleValues).forEach(function(key) {
    rendered = rendered.split(escapeHtml(key)).join(
      '<span class="template-preview-var">' + exampleValues[key] + '</span>'
    );
  });

  // Convert newlines to <br>
  rendered = rendered.replace(/\n/g, '<br>');

  preview.innerHTML = '<div class="template-preview-bubble">' + rendered + '</div>';
}

function updateCharCount() {
  var textarea = document.getElementById('templateContent');
  var counter = document.getElementById('templateCharCount');
  if (!textarea || !counter) return;

  var len = (textarea.value || '').length;
  counter.textContent = len + ' caracteres';
}

// ========== Setup Variable Chips ==========
function setupVariableChips() {
  var chips = document.querySelectorAll('.variable-chip');
  var textarea = document.getElementById('templateContent');
  if (!textarea) return;

  chips.forEach(function(chip) {
    chip.addEventListener('click', function(e) {
      e.preventDefault();
      var varText = chip.dataset.var;
      if (!varText) return;

      // Insert at cursor position
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      var text = textarea.value;

      textarea.value = text.substring(0, start) + varText + text.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + varText.length;
      textarea.focus();

      // Trigger preview update
      textarea.dispatchEvent(new Event('input'));
    });
  });
}

// ========== Setup Category Filter ==========
function setupCategoryFilter() {
  var select = document.getElementById('templateCategoryFilter');
  if (!select) return;

  select.addEventListener('change', function() {
    var category = select.value;
    loadTemplates(category || undefined);
  });
}

// ========== Helpers ==========
function escapeHtml(text) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  var date = new Date(dateStr);
  var now = new Date();
  var diff = Math.floor((now - date) / 1000);

  if (diff < 60) return 'Hace un momento';
  if (diff < 3600) return 'Hace ' + Math.floor(diff / 60) + ' min';
  if (diff < 86400) return 'Hace ' + Math.floor(diff / 3600) + 'h';
  if (diff < 604800) return 'Hace ' + Math.floor(diff / 86400) + 'd';

  return date.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ========== Initialize ==========
function initTemplates() {
  setupTemplatePreview();
  setupVariableChips();
  setupCategoryFilter();

  var saveBtn = document.getElementById('saveTemplateBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveTemplate);
  }

  var cancelBtn = document.getElementById('cancelEditTemplateBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', clearTemplateForm);
  }
}

// Global exports
window.initTemplates = initTemplates;
window.loadTemplates = loadTemplates;
window.useTemplate = useTemplate;
