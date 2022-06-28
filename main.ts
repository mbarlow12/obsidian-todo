import { values } from 'lodash';
import {
    App,
    CachedMetadata,
    debounce,
    Debouncer,
    MarkdownView,
    Plugin,
    PluginManifest,
    TAbstractFile,
    TFile,
    TFolder
} from 'obsidian';
import { TaskEvents } from "./src/Events/TaskEvents";
import { ActionType, IndexUpdateAction } from './src/Events/types';
import { DEFAULT_TASK_MANAGER_SETTINGS } from './src/Settings';
import { taskInstancesFromTask, TaskStore } from "./src/Store/TaskStore";
import { TaskInstanceIndex } from './src/Store/types';
import { instanceIndexKey, TaskInstance, taskLocationStr } from "./src/Task";
import { CacheStatus, filterIndexByPath, hashFileTaskState, TaskFileManager } from "./src/TaskFileManager";
import { TaskManagerSettings } from "./src/taskManagerSettings";
import { TaskEditorSuggest } from './src/TaskSuggest';

export default class ObsidianTaskManager extends Plugin {
    settings: TaskManagerSettings;
    taskStore: TaskStore;
    taskFileManager: TaskFileManager;
    taskSuggest: TaskEditorSuggest;
    private _activeFile: TFile;
    private vaultLoaded = false;
    private initialized = false;
    private taskEvents: TaskEvents;
    private changeDebouncers: Record<string, Debouncer<[ IndexUpdateAction ]>>;

    constructor( app: App, manifest: PluginManifest ) {
        super( app, manifest );
        this.changeDebouncers = {};
    }

    async onload() {

        this.app.workspace.onLayoutReady( async () => {
            if ( !this.initialized ) {
                this.taskEvents = new TaskEvents( this.app.workspace );
                this.taskStore = new TaskStore( this.taskEvents, this.settings );
                this.taskFileManager = new TaskFileManager( this.app.vault, this.app.metadataCache, this.taskEvents )
                await this.loadSettings();
                await this.registerEvents();
                if ( !this.vaultLoaded )
                    await this.processVault();
                // this.taskSuggest = new TaskEditorSuggest( app, this.taskEvents, this.taskStore.getState() );
                // this.registerEditorSuggest(this.taskSuggest);
                this.changeDebouncers = this.changeDebouncers || {};
                this.initialized = true;
            }
        } );
    }

    set activeFile( f: TFile ) {
        this._activeFile = f;
    }

    get activeFile() {
        return this._activeFile;
    }

    onunload() {
        this.taskStore?.unload();
        this.taskSuggest?.unsubscribe();
    }

    async loadSettings() {
        this.settings = Object.assign( {}, DEFAULT_TASK_MANAGER_SETTINGS, await this.loadData() );
        this.taskEvents.triggerSettingsUpdate( this.settings );
    }

    async saveSettings() {
        await this.saveData( this.settings );
    }

    registerEvents() {
        this.registerEvent( this.app.vault.on( 'delete', this.handleFileDeleted.bind( this ) ) );
        this.registerEvent( this.app.vault.on( 'rename', this.handleFileRenamed.bind( this ) ) );
        this.registerEvent( this.app.metadataCache.on( 'changed', this.handleCacheChanged.bind( this ) ) );
        const resolvedRef = this.app.metadataCache.on( 'resolve', debounce( async () => {
            if ( !this.vaultLoaded ) {
                await this.processVault();
                this.vaultLoaded = true;
            }
            else {
                this.app.metadataCache.offref( resolvedRef );
            }
        }, 500, true ) );
        this.registerEvent( this.app.workspace.on( 'file-open', async ( file ) => {
            if ( !file || this.ignorePath( file.path ) )
                return;

            this.activeFile = file;
            const { instanceIndex, taskIndex } = this.taskStore.getState();
            const storedIndex = filterIndexByPath( file.path, instanceIndex );
            const index = await this.taskFileManager.readMarkdownFile( file );
            const hash = hashFileTaskState( index );
            const storedHash = hashFileTaskState( storedIndex );

            if ( storedHash !== hash ) {
                this.taskFileManager.setFileStateHash( file.path, { status: CacheStatus.DIRTY, hash: storedHash } );
                if ( this.settings.indexFiles.has( file.path ) )
                    await this.taskFileManager.writeIndexFile( file, instanceIndex, taskIndex );
                else
                    await this.taskFileManager.writeStateToFile( file, filterIndexByPath( file.path, storedIndex ) );
            }
            else
                this.taskFileManager.setFileStateHash( file.path, { status: CacheStatus.CLEAN, hash: storedHash } );
        } ) );
    }

    private ignorePath( filePath: string ) {
        return this.settings.ignoredPaths.filter( ignored => filePath.includes( ignored ) ).length > 0;
    }

    private async handleCacheChanged( file: TFile, data: string, cache: CachedMetadata ) {

        if ( this.app.workspace.getActiveViewOfType<MarkdownView>( MarkdownView ) ) {
            if ( this.app.workspace.getActiveViewOfType( MarkdownView ).file.path !== file.path ) {
                // automated write from the file manager, don't trigger update
                return;
            }
        }

        if ( file !== this.activeFile || this.ignorePath( file.path ) )
            return

        if ( !this.taskFileManager.testAndSetFileStatus( file.path, CacheStatus.CLEAN ) ) {
            return;
        }

        const { line } = this.app.workspace.getActiveViewOfType( MarkdownView ).editor.getCursor();
        const fileInstanceIndex = await this.taskFileManager.getInstanceIndexFromFile( file );
        const cursorLineKey = instanceIndexKey( file.path, line );
        if ( cursorLineKey in fileInstanceIndex && fileInstanceIndex[ cursorLineKey ].uid === 0 )
            delete fileInstanceIndex[ instanceIndexKey( file.path, line ) ]
        const existingFileInstanceIndex: TaskInstanceIndex = values( this.taskStore.getState().instanceIndex )
            .filter( i => i.filePath === file.path )
            .reduce( ( idx, i ) => ({ ...idx, [ taskLocationStr( i ) ]: i }), {} );
        if ( hashFileTaskState( fileInstanceIndex ) !== hashFileTaskState( existingFileInstanceIndex ) ) {
            if ( !(file.path in this.changeDebouncers) )
                this.changeDebouncers[ file.path ] = debounce(
                    this.taskEvents.triggerFileCacheUpdate.bind( this.taskEvents ),
                    500,
                    true
                );
            this.changeDebouncers[ file.path ]( { type: ActionType.MODIFY_FILE_TASKS, data: fileInstanceIndex } );
        }
    }

    private async handleFileDeleted( abstractFile: TAbstractFile ) {
        if ( abstractFile instanceof TFile ) {
            if ( this.taskFileManager.getFileStateHash( abstractFile.path ) )
                this.taskEvents.triggerFileCacheUpdate( { type: ActionType.DELETE_FILE, data: abstractFile.path } )
        }
    }

    /**
     * if task file, we're renaming the task, and its presence in all parents & locations
     * if not a task file, we're only changing location references
     * @param abstractFile
     * @param oldPath
     * @private
     */
    private async handleFileRenamed( abstractFile: TAbstractFile, oldPath: string ) {
        if ( this.taskFileManager.getFileStateHash( oldPath ) ) {
            this.taskEvents.triggerFileCacheUpdate( {
                type: ActionType.RENAME_FILE,
                data: { oldPath, newPath: abstractFile.path }
            } )
        }
    }

    /**
     * Builds the index from the tasks directory.
     * @private
     */
    private async processTasksDirectory() {
        if ( !this.taskFileManager.tasksDirectory ) {
            await this.app.vault.createFolder( this.settings.taskDirectoryName );
            const tasksFolder = this.app.vault.getAbstractFileByPath( this.settings.taskDirectoryName );
            this.taskFileManager.tasksDirectory = tasksFolder as TFolder;
        }
        const tasksFolder = this.taskFileManager.tasksDirectory;
        const tasks = [];
        for ( const tFile of tasksFolder.children ) {
            tasks.push( this.taskFileManager.readTaskFile( tFile as TFile ) );
        }
        return Promise.all( tasks )
            .then( allTasks =>
                allTasks.reduce( (
                    st,
                    idxTask
                ) => [ ...st, ...taskInstancesFromTask( idxTask ) ], [] as TaskInstance[] )
            );
    }

    private async processVault() {
        if ( this.vaultLoaded ) return;
        const taskInstances = await this.processTasksDirectory();
        let fileTaskInstances: TaskInstance[] = [];
        for ( const file of this.app.vault.getMarkdownFiles() ) {
            if ( file.path.includes( this.settings.taskDirectoryName ) || this.ignorePath( file.path ) )
                continue;
            const fileInstanceIdx = await this.taskFileManager.readMarkdownFile( file );
            fileTaskInstances = [
                ...fileTaskInstances,
                ...values( fileInstanceIdx )
            ];
        }
        this.taskStore.initialize( [ ...taskInstances, ...fileTaskInstances ] )
        this.vaultLoaded = true;
    }
}
