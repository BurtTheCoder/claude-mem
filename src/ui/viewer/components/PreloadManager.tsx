import React, { useState, useEffect } from 'react';
import { usePreloads, Preload } from '../hooks/usePreloads';

interface PreloadManagerProps {
  isOpen: boolean;
  onClose: () => void;
  projects: string[];
  currentProject?: string;
}

type ViewMode = 'list' | 'view' | 'edit' | 'create';

export function PreloadManager({ isOpen, onClose, projects, currentProject }: PreloadManagerProps) {
  const [filterProject, setFilterProject] = useState(currentProject || '');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedPreload, setSelectedPreload] = useState<Preload | null>(null);
  const [formData, setFormData] = useState({ project: '', title: '', category: '', content: '' });
  const [isSaving, setIsSaving] = useState(false);

  const { preloads, isLoading, error, refresh, getPreload, createPreload, updatePreload, deletePreload } = usePreloads(filterProject || undefined);

  // Reset form when changing modes
  useEffect(() => {
    if (viewMode === 'create') {
      setFormData({
        project: filterProject || projects[0] || '',
        title: '',
        category: '',
        content: '',
      });
    } else if (viewMode === 'edit' && selectedPreload) {
      setFormData({
        project: selectedPreload.project,
        title: selectedPreload.title || '',
        category: selectedPreload.category || '',
        content: selectedPreload.content || '',
      });
    }
  }, [viewMode, selectedPreload, filterProject, projects]);

  // Sync filter with current project
  useEffect(() => {
    if (currentProject) {
      setFilterProject(currentProject);
    }
  }, [currentProject]);

  if (!isOpen) return null;

  const handleView = async (preload: Preload) => {
    const full = await getPreload(preload.id);
    if (full) {
      setSelectedPreload(full);
      setViewMode('view');
    }
  };

  const handleEdit = async (preload: Preload) => {
    const full = await getPreload(preload.id);
    if (full) {
      setSelectedPreload(full);
      setViewMode('edit');
    }
  };

  const handleDelete = async (preload: Preload) => {
    if (confirm(`Delete "${preload.title}"? This cannot be undone.`)) {
      await deletePreload(preload.id);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (viewMode === 'create') {
        await createPreload({
          project: formData.project,
          title: formData.title,
          category: formData.category || undefined,
          content: formData.content,
        });
      } else if (viewMode === 'edit' && selectedPreload) {
        await updatePreload(selectedPreload.id, {
          title: formData.title,
          category: formData.category || undefined,
          content: formData.content,
        });
      }
      setViewMode('list');
      setSelectedPreload(null);
    } finally {
      setIsSaving(false);
    }
  };

  const handleBack = () => {
    setViewMode('list');
    setSelectedPreload(null);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preload-manager" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {viewMode === 'list' && 'Preloaded Knowledge'}
            {viewMode === 'view' && 'View Preload'}
            {viewMode === 'edit' && 'Edit Preload'}
            {viewMode === 'create' && 'Create Preload'}
          </h2>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-content">
          {viewMode === 'list' && (
            <>
              <div className="preload-toolbar">
                <select
                  value={filterProject}
                  onChange={e => setFilterProject(e.target.value)}
                >
                  <option value="">All Projects</option>
                  {projects.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <button className="btn btn-primary" onClick={() => setViewMode('create')}>
                  + Add Knowledge
                </button>
              </div>

              {error && <div className="error-message">{error}</div>}

              {isLoading ? (
                <div className="loading">Loading...</div>
              ) : preloads.length === 0 ? (
                <div className="empty-state">
                  <p>No preloaded knowledge yet.</p>
                  <p className="hint">
                    Add knowledge that Claude should know about this project.
                  </p>
                </div>
              ) : (
                <div className="preload-list">
                  {preloads.map(preload => (
                    <div key={preload.id} className="preload-item">
                      <div className="preload-info">
                        <div className="preload-title">
                          {preload.category && (
                            <span className="preload-category">[{preload.category}]</span>
                          )}
                          {preload.title || preload.file_path}
                        </div>
                        <div className="preload-meta">
                          <span className="preload-project">{preload.project}</span>
                          <span className="preload-source">
                            {preload.source === 'file' ? '📁 File' : '✏️ UI'}
                          </span>
                          <span className="preload-date">{formatDate(preload.imported_at)}</span>
                        </div>
                        {preload.content_preview && (
                          <div className="preload-preview">
                            {preload.content_preview}...
                          </div>
                        )}
                      </div>
                      <div className="preload-actions">
                        <button className="btn btn-small" onClick={() => handleView(preload)}>
                          View
                        </button>
                        {preload.source === 'ui' && (
                          <>
                            <button className="btn btn-small" onClick={() => handleEdit(preload)}>
                              Edit
                            </button>
                            <button className="btn btn-small btn-danger" onClick={() => handleDelete(preload)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {viewMode === 'view' && selectedPreload && (
            <div className="preload-view">
              <div className="preload-view-header">
                <h3>
                  {selectedPreload.category && (
                    <span className="preload-category">[{selectedPreload.category}]</span>
                  )}
                  {selectedPreload.title}
                </h3>
                <div className="preload-view-meta">
                  <span>Project: {selectedPreload.project}</span>
                  <span>Source: {selectedPreload.source === 'file' ? 'File' : 'UI'}</span>
                  <span>Updated: {formatDate(selectedPreload.imported_at)}</span>
                </div>
              </div>
              <div className="preload-view-content">
                <pre>{selectedPreload.content}</pre>
              </div>
              <div className="preload-view-actions">
                <button className="btn" onClick={handleBack}>Back</button>
                {selectedPreload.source === 'ui' && (
                  <button className="btn btn-primary" onClick={() => setViewMode('edit')}>
                    Edit
                  </button>
                )}
              </div>
            </div>
          )}

          {(viewMode === 'edit' || viewMode === 'create') && (
            <div className="preload-form">
              {viewMode === 'create' && (
                <div className="form-group">
                  <label>Project</label>
                  <select
                    value={formData.project}
                    onChange={e => setFormData(d => ({ ...d, project: e.target.value }))}
                  >
                    {projects.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label>Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={e => setFormData(d => ({ ...d, title: e.target.value }))}
                  placeholder="e.g., Database Choice"
                />
              </div>
              <div className="form-group">
                <label>Category (optional)</label>
                <input
                  type="text"
                  value={formData.category}
                  onChange={e => setFormData(d => ({ ...d, category: e.target.value }))}
                  placeholder="e.g., Decisions, Architecture"
                />
              </div>
              <div className="form-group">
                <label>Content (Markdown)</label>
                <textarea
                  value={formData.content}
                  onChange={e => setFormData(d => ({ ...d, content: e.target.value }))}
                  placeholder="# Title&#10;&#10;Content here..."
                  rows={15}
                />
              </div>
              <div className="form-actions">
                <button className="btn" onClick={handleBack} disabled={isSaving}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={isSaving || !formData.title || !formData.content}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
