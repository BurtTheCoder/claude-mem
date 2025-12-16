import { useState, useEffect, useCallback } from 'react';

export interface Preload {
  id: number;
  project: string;
  file_path: string;
  title: string | null;
  category: string | null;
  source: string;
  imported_at: number;
  content_preview?: string;
  content?: string;
}

export function usePreloads(project?: string) {
  const [preloads, setPreloads] = useState<Preload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPreloads = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const url = project
        ? `/api/preloads?project=${encodeURIComponent(project)}`
        : '/api/preloads';
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch preloads');
      const data = await response.json();
      setPreloads(data.items || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [project]);

  useEffect(() => {
    fetchPreloads();
  }, [fetchPreloads]);

  const getPreload = async (id: number): Promise<Preload | null> => {
    try {
      const response = await fetch(`/api/preloads/${id}`);
      if (!response.ok) throw new Error('Failed to fetch preload');
      return await response.json();
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  };

  const createPreload = async (data: {
    project: string;
    title: string;
    category?: string;
    content: string;
  }): Promise<Preload | null> => {
    try {
      const response = await fetch('/api/preloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to create preload');
      }
      const preload = await response.json();
      await fetchPreloads();
      return preload;
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  };

  const updatePreload = async (
    id: number,
    data: { title: string; category?: string; content: string }
  ): Promise<Preload | null> => {
    try {
      const response = await fetch(`/api/preloads/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update preload');
      }
      const preload = await response.json();
      await fetchPreloads();
      return preload;
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  };

  const deletePreload = async (id: number): Promise<boolean> => {
    try {
      const response = await fetch(`/api/preloads/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to delete preload');
      }
      await fetchPreloads();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  };

  return {
    preloads,
    isLoading,
    error,
    refresh: fetchPreloads,
    getPreload,
    createPreload,
    updatePreload,
    deletePreload,
  };
}
