import * as shared from '@volar/shared';
import * as vue from '@volar/vue-language-service';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver';
import type { createConfigurationHost } from './configurationHost';
import { loadCustomPlugins } from '../common';
import { createSnapshots } from './snapshots';
import { LanguageConfigs, RuntimeEnvironment } from '../types';

export interface Project extends ReturnType<typeof createProject> { }

export async function createProject(
	runtimeEnv: RuntimeEnvironment,
	languageConfigs: LanguageConfigs,
	ts: typeof import('typescript/lib/tsserverlibrary'),
	projectSys: ts.System,
	options: shared.ServerInitializationOptions,
	rootPath: string,
	tsConfig: string | ts.CompilerOptions,
	tsLocalized: ts.MapLike<string> | undefined,
	documents: ReturnType<typeof createSnapshots>,
	connection: vscode.Connection,
	configHost: ReturnType<typeof createConfigurationHost> | undefined,
) {

	let typeRootVersion = 0;
	let projectVersion = 0;
	let vueLs: vue.LanguageService | undefined;
	let parsedCommandLine = createParsedCommandLine();

	const scripts = shared.createPathMap<{
		version: number,
		fileName: string,
		snapshot: ts.IScriptSnapshot | undefined,
		snapshotVersion: number | undefined,
	}>();
	const languageServiceHost = createLanguageServiceHost();

	return {
		onWorkspaceFilesChanged,
		onDocumentUpdated,
		getLanguageService,
		getLanguageServiceDontCreate: () => vueLs,
		getParsedCommandLine: () => parsedCommandLine,
		dispose,
	};

	function getLanguageService() {
		if (!vueLs) {
			vueLs = languageConfigs.createLanguageService(
				languageServiceHost,
				runtimeEnv.fileSystemProvide,
				(uri) => {

					const protocol = uri.substring(0, uri.indexOf(':'));

					const builtInHandler = runtimeEnv.schemaRequestHandlers[protocol];
					if (builtInHandler) {
						return builtInHandler(uri);
					}

					if (typeof options === 'object' && options.languageFeatures?.schemaRequestService) {
						return connection.sendRequest(shared.GetDocumentContentRequest.type, { uri }).then(responseText => {
							return responseText;
						}, error => {
							return Promise.reject(error.message);
						});
					}
					else {
						return Promise.reject('clientHandledGetDocumentContentRequest is false');
					}
				},
				configHost,
				loadCustomPlugins(languageServiceHost.getCurrentDirectory()),
				options.languageFeatures?.completion ? async (uri) => {

					if (options.languageFeatures?.completion?.getDocumentNameCasesRequest) {
						const res = await connection.sendRequest(shared.GetDocumentNameCasesRequest.type, { uri });
						return {
							tag: res.tagNameCase,
							attr: res.attrNameCase,
						};
					}

					return {
						tag: options.languageFeatures!.completion!.defaultTagNameCase,
						attr: options.languageFeatures!.completion!.defaultAttrNameCase,
					};
				} : undefined,
			);
		}
		return vueLs;
	}
	async function onWorkspaceFilesChanged(changes: vscode.FileEvent[]) {

		for (const change of changes) {

			const script = scripts.uriGet(change.uri);

			if (script && (change.type === vscode.FileChangeType.Changed || change.type === vscode.FileChangeType.Created)) {
				if (script.version >= 0) {
					script.version = -1;
				}
				else {
					script.version--;
				}
			}
			else if (script && change.type === vscode.FileChangeType.Deleted) {
				scripts.uriDelete(change.uri);
			}

			projectVersion++;
		}

		const creates = changes.filter(change => change.type === vscode.FileChangeType.Created);
		const deletes = changes.filter(change => change.type === vscode.FileChangeType.Deleted);

		if (creates.length || deletes.length) {
			parsedCommandLine = createParsedCommandLine();
			typeRootVersion++; // TODO: check changed in node_modules?
		}
	}
	async function onDocumentUpdated() {
		projectVersion++;
	}
	function createLanguageServiceHost() {

		const host: vue.LanguageServiceHost = {
			// ts
			getNewLine: () => projectSys.newLine,
			useCaseSensitiveFileNames: () => projectSys.useCaseSensitiveFileNames,
			readFile: projectSys.readFile,
			writeFile: projectSys.writeFile,
			directoryExists: projectSys.directoryExists,
			getDirectories: projectSys.getDirectories,
			readDirectory: projectSys.readDirectory,
			realpath: projectSys.realpath,
			fileExists: projectSys.fileExists,
			getCurrentDirectory: () => rootPath,
			getProjectReferences: () => parsedCommandLine.projectReferences, // if circular, broken with provide `getParsedCommandLine: () => parsedCommandLine`
			// custom
			getDefaultLibFileName: options => ts.getDefaultLibFilePath(options), // TODO: vscode option for ts lib
			getProjectVersion: () => projectVersion.toString(),
			getTypeRootsVersion: () => typeRootVersion,
			getScriptFileNames: () => {
				const fileNames = new Set(parsedCommandLine.fileNames);
				for (const script of scripts.values()) {
					fileNames.add(script.fileName);
				}
				return [...fileNames];
			},
			getCompilationSettings: () => parsedCommandLine.options,
			getVueCompilationSettings: () => parsedCommandLine.vueOptions,
			getScriptVersion,
			getScriptSnapshot,
			getTypeScriptModule: () => ts,
		};

		if (tsLocalized) {
			host.getLocalizedDiagnosticMessages = () => tsLocalized;
		}

		return host;

		function getScriptVersion(fileName: string) {

			const doc = documents.data.fsPathGet(fileName);
			if (doc) {
				return doc.version.toString();
			}

			return scripts.fsPathGet(fileName)?.version.toString() ?? '';
		}
		function getScriptSnapshot(fileName: string) {

			const doc = documents.data.fsPathGet(fileName);
			if (doc) {
				return doc.getSnapshot();
			}

			const script = scripts.fsPathGet(fileName);
			if (script && script.snapshotVersion === script.version) {
				return script.snapshot;
			}

			if (projectSys.fileExists(fileName)) {
				const text = projectSys.readFile(fileName, 'utf8');
				if (text !== undefined) {
					const snapshot = ts.ScriptSnapshot.fromString(text);
					if (script) {
						script.snapshot = snapshot;
						script.snapshotVersion = script.version;
					}
					else {
						scripts.fsPathSet(fileName, {
							version: -1,
							fileName: fileName,
							snapshot: snapshot,
							snapshotVersion: -1,
						});
					}
					return snapshot;
				}
			}
		}
	}
	function dispose() {
		vueLs?.dispose();
		scripts.clear();
	}
	function createParsedCommandLine(): ReturnType<typeof vue.createParsedCommandLine> {
		const parseConfigHost: ts.ParseConfigHost = {
			useCaseSensitiveFileNames: projectSys.useCaseSensitiveFileNames,
			readDirectory: (path, extensions, exclude, include, depth) => {
				const exts = [...extensions, ...languageConfigs.definitelyExts];
				for (const passiveExt of languageConfigs.indeterminateExts) {
					if (include.some(i => i.endsWith(passiveExt))) {
						exts.push(passiveExt);
					}
				}
				return projectSys.readDirectory(path, exts, exclude, include, depth);
			},
			fileExists: projectSys.fileExists,
			readFile: projectSys.readFile,
		};
		if (typeof tsConfig === 'string') {
			return vue.createParsedCommandLine(ts, parseConfigHost, tsConfig);
		}
		else {
			const content = ts.parseJsonConfigFileContent({}, parseConfigHost, rootPath, tsConfig, 'jsconfig.json');
			content.options.outDir = undefined; // TODO: patching ts server broke with outDir + rootDir + composite/incremental
			content.fileNames = content.fileNames.map(shared.normalizeFileName);
			return { ...content, vueOptions: {} };
		}
	}
}