// Frontend JavaScript for Production Breakdown Tool

let uploadedFiles = [];
let currentBreakdown = '';
let conversationHistory = [];

// DOM Elements
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const generateBtn = document.getElementById('generateBtn');
const uploadSection = document.getElementById('uploadSection');
const loadingSection = document.getElementById('loadingSection');
const resultsSection = document.getElementById('resultsSection');
const breakdownContent = document.getElementById('breakdownContent');
const downloadBtn = document.getElementById('downloadBtn');
const newBreakdownBtn = document.getElementById('newBreakdownBtn');
const editBtn = document.getElementById('editBtn');
const revisionInterface = document.getElementById('revisionInterface');
const revisionInput = document.getElementById('revisionInput');
const submitRevisionBtn = document.getElementById('submitRevisionBtn');
const cancelRevisionBtn = document.getElementById('cancelRevisionBtn');

// File Upload Handlers
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
});

fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    handleFiles(files);
});

function handleFiles(files) {
    uploadedFiles = [...uploadedFiles, ...files];
    renderFileList();
    updateGenerateButton();
}

function renderFileList() {
    if (uploadedFiles.length === 0) {
        fileList.innerHTML = '';
        return;
    }

    fileList.innerHTML = uploadedFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-info">
                <div class="file-icon">${getFileExtension(file.name)}</div>
                <div class="file-details">
                    <h4>${file.name}</h4>
                    <p>${formatFileSize(file.size)}</p>
                </div>
            </div>
            <button class="remove-file" onclick="removeFile(${index})">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        </div>
    `).join('');
}

function removeFile(index) {
    uploadedFiles.splice(index, 1);
    renderFileList();
    updateGenerateButton();
}

function updateGenerateButton() {
    generateBtn.disabled = uploadedFiles.length === 0;
}

function getFileExtension(filename) {
    const ext = filename.split('.').pop().toUpperCase();
    return ext.substring(0, 4);
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Generate Breakdown
generateBtn.addEventListener('click', async () => {
  showLoading();

  try {
    const formData = new FormData();
    uploadedFiles.forEach(file => {
      formData.append('files', file);
    });

    const response = await fetch('/api/generate-breakdown', {
      method: 'POST',
      body: formData
    });

    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      // response might not be JSON
    }

    if (!response.ok) {
      alert(data.error || `Failed to generate breakdown (HTTP ${response.status}).`);
      showUpload();
      return;
    }

    currentBreakdown = data.breakdown;
    conversationHistory = data.conversationHistory || [];
    showResults(data.breakdown);

  } catch (error) {
    console.error('Error:', error);
    alert(`Unexpected error: ${error.message}`);
    showUpload();
  }
});
// Revision Handlers
editBtn.addEventListener('click', () => {
    revisionInterface.classList.remove('hidden');
    revisionInput.focus();
});

cancelRevisionBtn.addEventListener('click', () => {
    revisionInterface.classList.add('hidden');
    revisionInput.value = '';
});

submitRevisionBtn.addEventListener('click', async () => {
    const revisionRequest = revisionInput.value.trim();
    
    if (!revisionRequest) {
        alert('Please enter a revision request');
        return;
    }

    revisionInterface.classList.add('hidden');
    showLoading();

    try {
        const response = await fetch('/api/revise-breakdown', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                revisionRequest,
                currentBreakdown,
                conversationHistory
            })
        });

        if (!response.ok) {
            throw new Error('Failed to revise breakdown');
        }

        const data = await response.json();
        currentBreakdown = data.breakdown;
        conversationHistory = data.conversationHistory || [];
        showResults(data.breakdown);
        revisionInput.value = '';
    } catch (error) {
        console.error('Error:', error);
        alert('Failed to revise breakdown. Please try again.');
        showResults(currentBreakdown);
    }
});

// Download Word Doc
downloadBtn.addEventListener('click', async () => {
    try {
        const response = await fetch('/api/download-docx', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ breakdown: currentBreakdown })
        });

        if (!response.ok) {
            throw new Error('Failed to generate document');
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `production-breakdown-${Date.now()}.docx`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (error) {
        console.error('Error:', error);
        alert('Failed to download document. Please try again.');
    }
});

// New Breakdown
newBreakdownBtn.addEventListener('click', () => {
    uploadedFiles = [];
    currentBreakdown = '';
    conversationHistory = [];
    fileInput.value = '';
    renderFileList();
    updateGenerateButton();
    showUpload();
});

// UI State Management
function showLoading() {
    uploadSection.classList.add('hidden');
    resultsSection.classList.add('hidden');
    loadingSection.classList.remove('hidden');
}

function showResults(breakdown) {
    uploadSection.classList.add('hidden');
    loadingSection.classList.add('hidden');
    resultsSection.classList.remove('hidden');
    breakdownContent.textContent = breakdown;
    revisionInterface.classList.add('hidden');
}

function showUpload() {
    resultsSection.classList.add('hidden');
    loadingSection.classList.add('hidden');
    uploadSection.classList.remove('hidden');
}
