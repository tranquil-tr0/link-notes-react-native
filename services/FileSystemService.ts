import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { openDocumentTree, listFiles, readFile, writeFile, mkdir, unlink, stat } from 'react-native-saf-x';
import { Note, NotePreview } from '@/types/Note';
import { DirectoryContents, FolderItem, NoteItem, FileSystemItem } from '@/types/FileSystemItem';

interface UserPreferences {
  showTimestamps: boolean;
  welcomeCompleted: boolean;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  showTimestamps: true,
  welcomeCompleted: false,
};

/**
 * Wrapper for AsyncStorage operations with timeout protection
 */
const asyncStorageWithTimeout = {
  async getItem(key: string, timeoutMs: number = 5000): Promise<string | null> {
    return Promise.race([
      AsyncStorage.getItem(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AsyncStorage.getItem timeout for key: ${key}`)), timeoutMs)
      )
    ]);
  },
  
  async setItem(key: string, value: string, timeoutMs: number = 5000): Promise<void> {
    return Promise.race([
      AsyncStorage.setItem(key, value),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AsyncStorage.setItem timeout for key: ${key}`)), timeoutMs)
      )
    ]);
  },
  
  async removeItem(key: string, timeoutMs: number = 5000): Promise<void> {
    return Promise.race([
      AsyncStorage.removeItem(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AsyncStorage.removeItem timeout for key: ${key}`)), timeoutMs)
      )
    ]);
  }
};

export class FileSystemService {
  private static instance: FileSystemService;
  private notesDirectory: string;
  private customDirectory: string | null = null;
  private userPreferences: UserPreferences = DEFAULT_PREFERENCES;
  private currentDirectory: string | null = null;
  
  // Cache implementation
  private notesCache: Map<string, NotePreview[]> = new Map();
  private noteContentCache: Map<string, Note> = new Map();
  private directoryPreferenceCache: string | null | undefined = undefined; // undefined = not loaded, null = no preference
  private lastCacheUpdate: number = 0;
  private cacheValidityDuration: number = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    if (Platform.OS === 'web') {
      this.notesDirectory = 'Notes';
    } else {
      // Default to app's document directory
      this.notesDirectory = `${FileSystem.documentDirectory}Notes/`;
    }
  }

  static getInstance(): FileSystemService {
    if (!FileSystemService.instance) {
      FileSystemService.instance = new FileSystemService();
    }
    return FileSystemService.instance;
  }

  /**
   * Get the current notes directory path
   */
  getNotesDirectory(): string {
    return this.customDirectory || this.notesDirectory;
  }

  /**
   * Get the current directory path (for navigation)
   */
  getCurrentDirectory(): string {
    return this.currentDirectory || this.getNotesDirectory();
  }

  /**
   * Set the current directory path (for navigation)
   */
  setCurrentDirectory(path: string): void {
    this.currentDirectory = path;
  }

  /**
   * Reset to root directory
   */
  resetToRootDirectory(): void {
    this.currentDirectory = null;
  }

  /**
   * Set a custom directory for notes storage (Android SAF)
   */
  async setCustomDirectory(directory: string): Promise<void> {
    this.customDirectory = directory;
    this.directoryPreferenceCache = directory || null;
    
    // Clear cache since directory changed
    this.clearCache();
    
    // Save the preference for persistence
    try {
      if (directory) {
        await asyncStorageWithTimeout.setItem('notes_directory_preference', directory);
      } else {
        // Remove the preference to use default app storage
        await asyncStorageWithTimeout.removeItem('notes_directory_preference');
      }
    } catch (error) {
      console.error('Failed to save directory preference:', error);
    }
  }

  /**
   * Clear all caches when filesystem changes
   */
  private clearCache(): void {
    this.notesCache.clear();
    this.noteContentCache.clear();
    this.lastCacheUpdate = 0;
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(): boolean {
    return Date.now() - this.lastCacheUpdate < this.cacheValidityDuration;
  }

  /**
   * Get cache key for notes based on directory
   */
  private getCacheKey(directory: string): string {
    return `notes_${directory}`;
  }

  /**
   * Load the saved directory preference (cached)
   */
  async loadDirectoryPreference(): Promise<void> {
    ;
    
    // Return cached result if already loaded
    if (this.directoryPreferenceCache !== undefined) {
      ;
      if (this.directoryPreferenceCache !== null) {
        this.customDirectory = this.directoryPreferenceCache;
      }
      return;
    }
    
    if (Platform.OS === 'web') {
      this.directoryPreferenceCache = null;
      return;
    }
    
    try {
      
      const savedDirectory = await asyncStorageWithTimeout.getItem('notes_directory_preference');
      ;
      
      if (savedDirectory) {
        ;
        this.customDirectory = savedDirectory;
        this.directoryPreferenceCache = savedDirectory;
      } else {
        this.directoryPreferenceCache = null;
      }
    } catch (error) {
      ;
      console.warn('AsyncStorage failed to load directory preference, using defaults');
      this.directoryPreferenceCache = null;
    }
  }

  /**
   * Let user select a custom directory for notes storage using SAF
   */
  async selectCustomDirectory(): Promise<string | null> {
    if (Platform.OS !== 'android') {
      return null;
    }

    try {
      // Use react-native-saf-x to open the document tree picker
      // This will prompt the user to select a directory and grant persistent permissions
      const result = await openDocumentTree(true); // true for persistent permissions
      
      if (result && result.uri) {
        // Store the directory URI for SAF access
        await this.setCustomDirectory(result.uri);
        
        // No need to create a Notes subdirectory - use the selected directory directly
        
        return result.uri;
      }
      
      return null;
    } catch (error) {
      console.error('Error selecting directory with SAF:', error);
      return null;
    }
  }

  /**
   * Parse SAF URI to a user-readable path
   */
  private parseSafUriToReadablePath(safUri: string): string {
    try {
      // SAF URIs typically look like: content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FNotes
      // We want to extract the path part and decode it
      
      if (!safUri.startsWith('content://')) {
        return safUri;
      }

      // Extract the path part after 'tree/'
      const treeMatch = safUri.match(/\/tree\/(.+)$/);
      if (!treeMatch) {
        return 'Custom Folder';
      }

      let pathPart = treeMatch[1];
      
      // Decode URI components
      pathPart = decodeURIComponent(pathPart);
      
      // Handle different storage types
      if (pathPart.startsWith('primary:')) {
        // Internal storage
        const relativePath = pathPart.substring('primary:'.length);
        return relativePath || 'Internal Storage';
      } else if (pathPart.includes(':')) {
        // External storage or other providers
        const parts = pathPart.split(':');
        if (parts.length >= 2) {
          const storageName = parts[0];
          const relativePath = parts.slice(1).join(':');
          
          // Try to make storage names more readable
          if (storageName.toLowerCase().includes('sd') || storageName.toLowerCase().includes('external')) {
            return relativePath ? `SD Card/${relativePath}` : 'SD Card';
          } else if (storageName === 'primary') {
            return relativePath || 'Internal Storage';
          } else {
            return relativePath ? `${storageName}/${relativePath}` : storageName;
          }
        }
      }
      
      // Fallback to the decoded path
      return pathPart || 'Custom Folder';
    } catch (error) {
      console.error('Error parsing SAF URI:', error);
      return 'Custom Folder';
    }
  }

  /**
   * Get storage location info for display
   */
  async getStorageLocationInfo(): Promise<{ location: string; type: 'app' | 'public' | 'custom' }> {
    // Always ensure directory preference is loaded before getting location info
    await this.loadDirectoryPreference();
    
    const currentDir = this.getNotesDirectory();
    
    if (Platform.OS === 'web') {
      return { location: 'Browser Local Storage', type: 'app' };
    }

    if (currentDir === this.notesDirectory) {
      return { location: 'App Documents Folder', type: 'app' };
    }

    if (currentDir.startsWith('content://')) {
      const readablePath = this.parseSafUriToReadablePath(currentDir);
      return { location: readablePath, type: 'custom' };
    }

    if (currentDir.includes('Documents/Notes')) {
      return { location: 'Device Documents/Notes', type: 'public' };
    }

    return { location: currentDir, type: 'custom' };
  }

  /**
   * Sanitize a title to be used as a filename
   */
  private sanitizeFilename(title: string): string {
    // Remove invalid characters for filesystem but keep spaces
    return title
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
      .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
      .replace(/\.+$/, '') // Remove trailing dots
      .substring(0, 100) // Limit length
      .trim() || 'Untitled'; // Fallback if empty
  }

  /**
   * Extract title from note content
   */
  private extractTitle(content: string): string {
    const lines = content.split('\n');
    const firstLine = lines[0] || '';
    return firstLine.replace(/^#\s*/, '') || 'Untitled';
  }

  async ensureDirectoryExists(): Promise<void> {
    if (Platform.OS === 'web') {
      // Web doesn't need directory creation
      return;
    }
    
    const currentDir = this.getNotesDirectory();
    
    if (currentDir.startsWith('content://')) {
      // SAF path - directory should already exist (user selected it)
      // No need to create subdirectory
    } else {
      // Regular file system path
      const dirInfo = await FileSystem.getInfoAsync(currentDir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(currentDir, { intermediates: true });
      }
    }
  }

  async getAllNotes(): Promise<NotePreview[]> {
    // Load directory preference first
    await this.loadDirectoryPreference();
    await this.ensureDirectoryExists();
    
    if (Platform.OS === 'web') {
      return this.getWebNotes();
    }
    
    const currentDir = this.getNotesDirectory();
    
    try {
      // Check if we're using SAF (URI starts with content://)
      if (currentDir.startsWith('content://')) {
        return await this.getSAFNotes(currentDir);
      } else {
        return await this.getFileSystemNotes(currentDir);
      }
    } catch (error) {
      console.error('Error reading notes:', error);
      return [];
    }
  }

  private async getSAFNotes(directoryUri: string): Promise<NotePreview[]> {
    const cacheKey = this.getCacheKey(directoryUri);
    
    // Check cache first
    if (this.isCacheValid() && this.notesCache.has(cacheKey)) {
      return this.notesCache.get(cacheKey)!;
    }
    
    try {
      const files = await listFiles(directoryUri);
      const markdownFiles = files.filter(file => file.name.endsWith('.md') && file.type === 'file');
      
      // Read files in parallel using Promise.all
      const notePromises = markdownFiles.map(async (file) => {
        try {
          // Read only first 200 characters for preview
          const content = await readFile(file.uri);
          const filename = file.name.replace('.md', '');
          const preview = content.substring(0, 200);
          
          return {
            filename,
            preview,
            createdAt: new Date(file.lastModified),
            updatedAt: new Date(file.lastModified),
            filePath: file.uri,
          };
        } catch (fileError) {
          console.error(`Error reading file ${file.name}:`, fileError);
          return null;
        }
      });
      
      const notesResults = await Promise.all(notePromises);
      const notes = notesResults.filter(note => note !== null) as NotePreview[];
      const sortedNotes = notes.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      
      // Update cache
      this.notesCache.set(cacheKey, sortedNotes);
      this.lastCacheUpdate = Date.now();
      
      return sortedNotes;
    } catch (error) {
      console.error('Error reading SAF notes:', error);
      return [];
    }
  }

  private async getFileSystemNotes(currentDir: string): Promise<NotePreview[]> {
    const cacheKey = this.getCacheKey(currentDir);
    
    // Check cache first
    if (this.isCacheValid() && this.notesCache.has(cacheKey)) {
      return this.notesCache.get(cacheKey)!;
    }
    
    try {
      const files = await FileSystem.readDirectoryAsync(currentDir);
      const markdownFiles = files.filter(file => file.endsWith('.md'));
      
      // Read files in parallel using Promise.all
      const notePromises = markdownFiles.map(async (file) => {
        try {
          const filePath = `${currentDir}${file}`;
          
          // Read only first 200 characters for preview
          const content = await FileSystem.readAsStringAsync(filePath);
          const stat = await FileSystem.getInfoAsync(filePath);
          
          const filename = file.replace('.md', '');
          const preview = content.substring(0, 200);
          
          const modTime = stat.exists && 'modificationTime' in stat ? stat.modificationTime : Date.now();
          
          return {
            filename,
            preview,
            createdAt: new Date(modTime),
            updatedAt: new Date(modTime),
            filePath,
          };
        } catch (fileError) {
          console.error(`Error reading file ${file}:`, fileError);
          return null;
        }
      });
      
      const notesResults = await Promise.all(notePromises);
      const notes = notesResults.filter(note => note !== null) as NotePreview[];
      const sortedNotes = notes.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      
      // Update cache
      this.notesCache.set(cacheKey, sortedNotes);
      this.lastCacheUpdate = Date.now();
      
      return sortedNotes;
    } catch (error) {
      console.error('Error reading file system notes:', error);
      return [];
    }
  }

  private getWebNotes(): NotePreview[] {
    const notesData = localStorage.getItem('notes');
    if (!notesData) return [];
    
    try {
      const notes = JSON.parse(notesData);
      return notes.map((note: any) => ({
        ...note,
        createdAt: new Date(note.createdAt),
        updatedAt: new Date(note.updatedAt),
      }));
    } catch {
      return [];
    }
  }

  async getNote(filename: string, folderPath?: string): Promise<Note | null> {
    if (Platform.OS === 'web') {
      return this.getWebNote(filename);
    }
    
    // Create cache key for individual note
    const cacheKey = `note_${filename}_${folderPath || 'root'}`;
    
    // Check cache first
    if (this.isCacheValid() && this.noteContentCache.has(cacheKey)) {
      return this.noteContentCache.get(cacheKey)!;
    }
    
    try {
      // Determine the target directory
      let targetDir: string;
      const rootDir = this.getNotesDirectory();
      
      if (folderPath && folderPath.trim() !== '') {
        // Construct path to specific folder
        if (rootDir.startsWith('content://')) {
          // SAF path
          targetDir = `${rootDir}/${folderPath}`;
        } else {
          // Regular filesystem path
          targetDir = `${rootDir}${folderPath}/`;
        }
      } else {
        // Use root directory
        targetDir = rootDir;
      }
      
      let note: Note;
      
      if (targetDir.startsWith('content://')) {
        // SAF path
        const fileUri = `${targetDir}/${filename}.md`;
        
        const content = await readFile(fileUri);
        const fileStat = await stat(fileUri);
        
        note = {
          filename,
          content,
          createdAt: new Date(fileStat.lastModified),
          updatedAt: new Date(fileStat.lastModified),
          filePath: fileUri,
        };
      } else {
        // Regular file system path
        const filePath = `${targetDir}${filename}.md`;
        const content = await FileSystem.readAsStringAsync(filePath);
        const fileStat = await FileSystem.getInfoAsync(filePath);
        
        const modTime = fileStat.exists && 'modificationTime' in fileStat ? fileStat.modificationTime : Date.now();
        
        note = {
          filename,
          content,
          createdAt: new Date(modTime),
          updatedAt: new Date(modTime),
          filePath,
        };
      }
      
      // Cache the note
      this.noteContentCache.set(cacheKey, note);
      
      return note;
    } catch (error) {
      console.error('Error reading note:', error);
      return null;
    }
  }

  private getWebNote(id: string): Note | null {
    const notesData = localStorage.getItem('notes');
    if (!notesData) return null;
    
    try {
      const notes = JSON.parse(notesData);
      const note = notes.find((n: any) => n.id === id);
      if (!note) return null;
      
      return {
        ...note,
        createdAt: new Date(note.createdAt),
        updatedAt: new Date(note.updatedAt),
      };
    } catch {
      return null;
    }
  }

  async saveNote(note: Note, oldFilename?: string, folderPath?: string): Promise<void> {
    if (Platform.OS === 'web') {
      await this.saveWebNote(note);
      return;
    }
    
    await this.ensureDirectoryExists();
    
    try {
      // Determine the target directory
      let targetDir: string;
      const rootDir = this.getNotesDirectory();
      
      if (folderPath && folderPath.trim() !== '') {
        // Construct path to specific folder
        if (rootDir.startsWith('content://')) {
          // SAF path
          targetDir = `${rootDir}/${folderPath}`;
        } else {
          // Regular filesystem path
          targetDir = `${rootDir}${folderPath}/`;
        }
      } else {
        // Use root directory
        targetDir = rootDir;
      }
      
      // If filename changed, delete the old file first
      if (oldFilename && oldFilename !== note.filename) {
        try {
          await this.deleteNote(oldFilename, folderPath);
        } catch (error) {
          console.log('Old file not found or could not be deleted:', error);
        }
      }
      
      if (targetDir.startsWith('content://')) {
        // SAF path
        const fileUri = `${targetDir}/${note.filename}.md`;
        await writeFile(fileUri, note.content);
      } else {
        // Regular file system path
        const filePath = `${targetDir}${note.filename}.md`;
        await FileSystem.writeAsStringAsync(filePath, note.content);
      }
      
      // Clear cache after saving
      this.clearCache();
    } catch (error) {
      console.error('Error saving note:', error);
      throw error;
    }
  }

  private async saveWebNote(note: Note): Promise<void> {
    const notesData = localStorage.getItem('notes');
    let notes: any[] = [];
    
    if (notesData) {
      try {
        notes = JSON.parse(notesData);
      } catch {
        notes = [];
      }
    }
    
    const existingIndex = notes.findIndex(n => n.filename === note.filename);
    const noteData = {
      ...note,
      createdAt: note.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    if (existingIndex >= 0) {
      notes[existingIndex] = noteData;
    } else {
      notes.push(noteData);
    }
    
    localStorage.setItem('notes', JSON.stringify(notes));
  }

  async deleteNote(id: string, folderPath?: string): Promise<void> {
    if (Platform.OS === 'web') {
      await this.deleteWebNote(id);
      return;
    }
    
    try {
      // Determine the target directory
      let targetDir: string;
      const rootDir = this.getNotesDirectory();
      
      if (folderPath && folderPath.trim() !== '') {
        // Construct path to specific folder
        if (rootDir.startsWith('content://')) {
          // SAF path
          targetDir = `${rootDir}/${folderPath}`;
        } else {
          // Regular filesystem path
          targetDir = `${rootDir}${folderPath}/`;
        }
      } else {
        // Use root directory
        targetDir = rootDir;
      }
      
      if (targetDir.startsWith('content://')) {
        // SAF path
        const fileUri = `${targetDir}/${id}.md`;
        await unlink(fileUri);
      } else {
        // Regular file system path
        const filePath = `${targetDir}${id}.md`;
        await FileSystem.deleteAsync(filePath);
      }
      
      // Clear cache after deleting
      this.clearCache();
    } catch (error) {
      console.error('Error deleting note:', error);
      throw error;
    }
  }

  private async deleteWebNote(id: string): Promise<void> {
    const notesData = localStorage.getItem('notes');
    if (!notesData) return;
    
    try {
      const notes = JSON.parse(notesData);
      const filteredNotes = notes.filter((n: any) => n.id !== id);
      localStorage.setItem('notes', JSON.stringify(filteredNotes));
    } catch (error) {
      console.error('Error deleting web note:', error);
    }
  }

  /**
   * Load user preferences from storage
   */
  async loadUserPreferences(): Promise<void> {
    ;
    try {
      
      const preferencesData = await asyncStorageWithTimeout.getItem('user_preferences');
      ;
      
      if (preferencesData) {
        this.userPreferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(preferencesData) };
        ;
      } else {
        this.userPreferences = DEFAULT_PREFERENCES;
      }
    } catch (error) {
      ;
      console.warn('AsyncStorage failed to load user preferences, using defaults');
      this.userPreferences = DEFAULT_PREFERENCES;
    }
  }

  /**
   * Save user preferences to storage
   */
  async saveUserPreferences(preferences: Partial<UserPreferences>): Promise<void> {
    try {
      this.userPreferences = { ...this.userPreferences, ...preferences };
      await asyncStorageWithTimeout.setItem('user_preferences', JSON.stringify(this.userPreferences));
    } catch (error) {
      console.error('Failed to save user preferences:', error);
    }
  }

  /**
   * Get current user preferences
   */
  getUserPreferences(): UserPreferences {
    return this.userPreferences;
  }

  /**
   * Get specific preference value
   */
  getShowTimestamps(): boolean {
    return this.userPreferences.showTimestamps;
  }

  /**
   * Set timestamp visibility preference
   */
  async setShowTimestamps(show: boolean): Promise<void> {
    await this.saveUserPreferences({ showTimestamps: show });
  }

  /**
   * Check if welcome screen has been completed
   */
  getWelcomeCompleted(): boolean {
    return this.userPreferences.welcomeCompleted;
  }

  /**
   * Set welcome screen completion status
   */
  async setWelcomeCompleted(completed: boolean): Promise<void> {
    await this.saveUserPreferences({ welcomeCompleted: completed });
  }

  /**
   * Get directory contents (folders and notes) for the current directory
   */
  async getDirectoryContents(directoryPath?: string): Promise<DirectoryContents> {
    const targetPath = directoryPath || this.getCurrentDirectory();
    const rootPath = this.getNotesDirectory();
    
    // Load directory preference first
    await this.loadDirectoryPreference();
    await this.ensureDirectoryExists();
    
    if (Platform.OS === 'web') {
      return this.getWebDirectoryContents(targetPath, rootPath);
    }
    
    try {
      // Check if we're using SAF (URI starts with content://)
      if (targetPath.startsWith('content://')) {
        return await this.getSAFDirectoryContents(targetPath, rootPath);
      } else {
        return await this.getFileSystemDirectoryContents(targetPath, rootPath);
      }
    } catch (error) {
      console.error('Error reading directory contents:', error);
      return {
        folders: [],
        notes: [],
        currentPath: targetPath,
        parentPath: this.getParentPath(targetPath, rootPath),
      };
    }
  }

  /**
   * Get parent path for navigation
   */
  private getParentPath(currentPath: string, rootPath: string): string | null {
    if (currentPath === rootPath) {
      return null; // Already at root
    }
    
    if (currentPath.startsWith('content://')) {
      // SAF path - extract parent
      const pathParts = currentPath.split('/');
      if (pathParts.length > 4) { // content://authority/tree/document/...
        return pathParts.slice(0, -1).join('/');
      }
      return rootPath;
    } else {
      // Regular filesystem path
      const pathParts = currentPath.split('/');
      if (pathParts.length > 1) {
        const parentPath = pathParts.slice(0, -1).join('/') + '/';
        return parentPath.length >= rootPath.length ? parentPath : null;
      }
      return null;
    }
  }

  /**
   * Get directory contents using SAF
   */
  private async getSAFDirectoryContents(directoryUri: string, rootPath: string): Promise<DirectoryContents> {
    try {
      const files = await listFiles(directoryUri);
      const { folders, markdownFiles } = this.separateFoldersAndMarkdownFiles(files);

      const notes = await this.processMarkdownFiles(markdownFiles, async (file) => {
        const content = await readFile(file.uri);
        return {
          filename: file.name.replace('.md', ''),
          preview: content.substring(0, 200),
          createdAt: new Date(file.lastModified),
          updatedAt: new Date(file.lastModified),
          filePath: file.uri,
          type: 'note' as const,
        };
      });

      return this.buildDirectoryContents(folders, notes, directoryUri, rootPath);
    } catch (error) {
      console.error('Error reading SAF directory contents:', error);
      return this.buildEmptyDirectoryContents(directoryUri, rootPath);
    }
  }

  /**
   * Get directory contents using regular filesystem
   */
  private async getFileSystemDirectoryContents(currentDir: string, rootPath: string): Promise<DirectoryContents> {
    try {
      const files = await FileSystem.readDirectoryAsync(currentDir);
      const { folders, markdownFiles } = await this.processRegularFiles(files, currentDir);

      const notes = await this.processMarkdownFiles(markdownFiles, async (file) => {
        const filePath = `${currentDir}${file}`;
        const [content, stat] = await Promise.all([
          FileSystem.readAsStringAsync(filePath),
          FileSystem.getInfoAsync(filePath),
        ]);
        const modTime = stat.exists && 'modificationTime' in stat ? stat.modificationTime : Date.now();
        return {
          filename: file.replace('.md', ''),
          preview: content.substring(0, 200),
          createdAt: new Date(modTime),
          updatedAt: new Date(modTime),
          filePath,
          type: 'note' as const,
        };
      });

      return this.buildDirectoryContents(folders, notes, currentDir, rootPath);
    } catch (error) {
      console.error('Error reading filesystem directory contents:', error);
      return this.buildEmptyDirectoryContents(currentDir, rootPath);
    }
  }

  /**
   * Get directory contents for web platform
   */
  private getWebDirectoryContents(targetPath: string, rootPath: string): DirectoryContents {
    // For web, we'll simulate folder structure using localStorage
    // This is a simplified implementation - in a real app, you might want more sophisticated folder handling
    const notesData = localStorage.getItem('notes');
    const notes: NoteItem[] = [];
    
    if (notesData) {
      try {
        const allNotes = JSON.parse(notesData);
        allNotes.forEach((note: any) => {
          notes.push({
            filename: note.filename,
            preview: note.preview || note.content?.substring(0, 200) || '',
            createdAt: new Date(note.createdAt),
            updatedAt: new Date(note.updatedAt),
            filePath: note.filePath || `${targetPath}/${note.filename}.md`,
            type: 'note',
          });
        });
      } catch {
        // Handle parsing errors
      }
    }
    
    return {
      folders: [], // Web doesn't support real folders in this implementation
      notes: notes.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
      currentPath: targetPath,
      parentPath: null, // Web implementation doesn't support folder navigation
    };
  }

  /**
   * Helper to separate folders and markdown files
   */
  private separateFoldersAndMarkdownFiles(files: any[]): { folders: FolderItem[]; markdownFiles: any[] } {
    const folders: FolderItem[] = [];
    const markdownFiles: any[] = [];
    for (const file of files) {
      if (file.type === 'directory') {
        folders.push({
          name: file.name,
          type: 'folder',
          path: file.uri,
          createdAt: new Date(file.lastModified),
          updatedAt: new Date(file.lastModified),
        });
      } else if (file.name.endsWith('.md')) {
        markdownFiles.push(file);
      }
    }
    return { folders, markdownFiles };
  }

  /**
   * Helper to process markdown files
   */
  private async processMarkdownFiles(files: any[], processFile: (file: any) => Promise<NoteItem | null>): Promise<NoteItem[]> {
    const notePromises = files.map(processFile);
    const notesResults = await Promise.all(notePromises);
    return notesResults.filter(note => note !== null) as NoteItem[];
  }

  /**
   * Helper to process regular files and find folders
   */
  private async processRegularFiles(files: string[], currentDir: string): Promise<{ folders: FolderItem[]; markdownFiles: string[] }> {
    const folders: FolderItem[] = [];
    const markdownFiles: string[] = [];
    const regularFiles: string[] = [];

    for (const file of files) {
      if (file.endsWith('.md')) {
        markdownFiles.push(file);
      } else {
        regularFiles.push(file);
      }
    }

    const folderPromises = regularFiles.map(async (file) => {
      try {
        const filePath = `${currentDir}${file}`;
        const stat = await FileSystem.getInfoAsync(filePath);
        if (stat.exists && stat.isDirectory) {
          const modTime = 'modificationTime' in stat ? stat.modificationTime : Date.now();
          return {
            name: file,
            type: 'folder' as const,
            path: filePath + '/',
            createdAt: new Date(modTime),
            updatedAt: new Date(modTime),
          };
        }
        return null;
      } catch (error) {
        console.error(`Error processing file ${file}:`, error);
        return null;
      }
    });

    const folderResults = await Promise.all(folderPromises);
    folders.push(...folderResults.filter(folder => folder !== null) as FolderItem[]);
    return { folders, markdownFiles };
  }

  /**
   * Helper to build directory contents
   */
  private buildDirectoryContents(folders: FolderItem[], notes: NoteItem[], currentPath: string, rootPath: string): DirectoryContents {
    folders.sort((a, b) => a.name.localeCompare(b.name));
    notes.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return {
      folders,
      notes,
      currentPath,
      parentPath: this.getParentPath(currentPath, rootPath),
    };
  }

  /**
   * Helper to build empty directory contents
   */
  private buildEmptyDirectoryContents(currentPath: string, rootPath: string): DirectoryContents {
    return {
      folders: [],
      notes: [],
      currentPath,
      parentPath: this.getParentPath(currentPath, rootPath),
    };
  }

  /**
   * Navigate to a specific directory
   */
  async navigateToDirectory(path: string): Promise<DirectoryContents> {
    this.setCurrentDirectory(path);
    return await this.getDirectoryContents(path);
  }

  /**
   * Navigate to parent directory
   */
  async navigateToParent(): Promise<DirectoryContents | null> {
    const currentContents = await this.getDirectoryContents();
    if (currentContents.parentPath) {
      this.setCurrentDirectory(currentContents.parentPath);
      return await this.getDirectoryContents(currentContents.parentPath);
    }
    return null;
  }

  /**
   * Navigate to root directory
   */
  async navigateToRoot(): Promise<DirectoryContents> {
    this.resetToRootDirectory();
    return await this.getDirectoryContents();
  }
}