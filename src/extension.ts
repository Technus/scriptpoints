import * as vscode from 'vscode';
import { Breakpoint, SourceBreakpoint, DebugSession, Position, window, debug } from 'vscode';
const { spawn } = require('child_process');
import { DebugProtocol } from 'vscode-debugprotocol';

// Log message beginning with ! is used as a scriptpoint
function isScriptpoint(message?: string) {
	return (message && message.length > 0 && message[0] === '!');
}

// Scriptpoint beginning with !! breaks when hit
function isBreakScriptpoint(message: string) {
	return (message.length > 2 && message[1] === '!');
}

// Executes a scriptpoint.  Returns true on success, false in case of error.
async function executeScriptpoint(script: string, session: DebugSession, frameId: number): Promise<boolean> {
	return new Promise<boolean>(async (resolve, reject) => {
		// Set up the environment script environment
		let log = (message: string) => {
			debug.activeDebugConsole.appendLine(message);
		};
		let command = (command: string, ...args: any[]) => vscode.commands.executeCommand(command, ...args);
		let evaluate = async (expression: string) => {
			const evaluateArgs: DebugProtocol.EvaluateArguments = { expression: expression, frameId: frameId };
			const response = await session.customRequest('evaluate', evaluateArgs) as DebugProtocol.EvaluateResponse["body"];
			return response.result;
		};
		let variableCrawl = async (variablesReference: number, indentLevel: number) => {
			let out = "";
			if (variablesReference > 0) {
				const variablesArgs: DebugProtocol.VariablesArguments = { variablesReference: variablesReference };
				const variables = await session.customRequest('variables', variablesArgs) as DebugProtocol.VariablesResponse["body"]["variables"];
				variables.forEach(variable => {
					out += "  ".repeat(indentLevel) + variable.name + ": " + variable.value + "\n";
					out += variableCrawl(variable.variablesReference, indentLevel + 1);
				});
			}
			return out;
		};
		let variables = async (expression: string) => {
			const evaluateArgs: DebugProtocol.EvaluateArguments = { expression: expression, frameId: frameId };
			const response = await session.customRequest('evaluate', evaluateArgs) as DebugProtocol.EvaluateResponse["body"];
			let out = expression + ": " + response.result + "\n";
			out += variableCrawl(response.variablesReference, 1);
			return out;
		};
		let memory = async (expression: string, size: number) => {
			const evaluateArgs: DebugProtocol.EvaluateArguments = { expression: expression, frameId: frameId };
			const response = await session.customRequest('evaluate', evaluateArgs);
			const memoryArgs: DebugProtocol.ReadMemoryArguments = { memoryReference: response.memoryReference, offset: 0, count: size };
			const memory = await session.customRequest('readMemory', memoryArgs);
			return memory.data;
		};

		try {
			let f = Function('"use strict"; return async function(log, command, evaluate, variables, memory){ ' + script + ' }')();
			await f(log, command, evaluate, variables, memory);
		}
		catch (e) {
			let errorMessage = 'Scriptpoint exception "' + e + '" executing: "' + script + '"';
			debug.activeDebugConsole.appendLine('\u001b[31m' + errorMessage + '\u001b[0m');
			resolve(false);
			return;
		}

		resolve(true);
	});
}

export function activate(context: vscode.ExtensionContext) {
	// Discussion in https://github.com/microsoft/vscode/issues/63444 says that you need to register for BreakpointsChangeEvent
	// in order for vscode.debug.breakpoints to be kept up to date.  That quote has been removed from the linked documentation,
	// but it appears to be true that without registering an event, vscodedebug.breakpoints is sometimes empty even after one of
	// the breakpoints has already been hit.
	context.subscriptions.push(debug.onDidChangeBreakpoints((e: vscode.BreakpointsChangeEvent) => { }));

	class Scriptpoint {
		constructor(index: number, script: string, stop: boolean) {
			this.index = index;
			this.script = script;
			this.stop = stop;
			this.breakpoint = undefined;
		}

		index: number; // Index in the SetBreakpoints reqeuest
		script: string; // Script to execute when hit
		stop: boolean; // Whether to stop execution when hit
		breakpoint: DebugProtocol.Breakpoint | undefined;
	}

	class ScriptpointSource {
		setBreakpointsSeq: number = -1; // Sequence number of the latest SetBreakpoints request
		scriptpoints: Scriptpoint[] = []; // List of scriptpoints in the source
	}

	context.subscriptions.push(vscode.commands.registerCommand('scriptpoints.test', () => {
		vscode.debug.activeDebugConsole.appendLine('foo');
		vscode.debug.activeDebugConsole.appendLine('bar');
	}));

	// Snoop on messages between vs code and the debugger to infer the active thread and stack frame
	context.subscriptions.push(debug.registerDebugAdapterTrackerFactory("*",
		{
			createDebugAdapterTracker: (session:any) => {
				let setBreakpointsSeq = -1; // Sequence ID of the latest SetBreakpoints request
				let sources = new Map<string, ScriptpointSource>(); // Map source identifier to a list of scriptpoints
				let idToSource = new Map<number, ScriptpointSource>(); // Map breakpoint identifier to a list of scriptpoints
				let step = false; // true if execution was last continued by a step command

				return {
					onWillStartSession: () => {
					},

					onWillEndSession: () => {
					},

					onDidSendMessage: async (message: DebugProtocol.ProtocolMessage) => {
						if (message.type === 'response') {
							let response = message as DebugProtocol.Response;
							for (const source of sources.values()) {
								if (source.setBreakpointsSeq === response.request_seq) {
									// Save the breakpoints so that they can be identified when the debugger stops
									let breakpointsResponse = response as DebugProtocol.SetBreakpointsResponse;
									for (const scriptpoint of source.scriptpoints) {
										scriptpoint.breakpoint = breakpointsResponse.body.breakpoints[scriptpoint.index];

										// If the breakpoint has an ID, map it to the source
										// This is necessary because, for some reason, later BreakpointEvents
										// can give the source path with different casing, but on some OS paths
										// are case sensitive
										if (scriptpoint.breakpoint.id) {
											idToSource.set(scriptpoint.breakpoint.id, source);
										}
									}
								}
							}
						}
						else if (message.type === 'event') {
							let event = message as DebugProtocol.Event;
							if (event.event === 'stopped') {
								let stopped = event as DebugProtocol.StoppedEvent;
								let threadId = stopped.body.threadId ?? 0; // TODO what to use when no thread ID is specified?
								let stepped = step;
								step = false;

								try {
									// Do a stack trace to find out where we are
									let stackArgs: DebugProtocol.StackTraceArguments = { threadId: threadId, startFrame: 0, levels: 1 };
									const stackTrace = await session.customRequest('stackTrace', stackArgs);
									if (!stackTrace.stackFrames || stackTrace.stackFrames.length === 0) {
										return;
									}

									const frame = stackTrace.stackFrames[0] as DebugProtocol.StackFrame;
									if (!frame.source || !frame.source.path) {
										return; // todo: support source references
									}
									const source = sources.get(frame.source.path);
									if (!source) {
										return;
									}

									for (const scriptpoint of source.scriptpoints) {
										if (!scriptpoint.breakpoint) {
											continue; // unexpected
										}

										// Check if the debugger is stopped at the scriptpoint
										let breakpoint = scriptpoint.breakpoint;
										let match: boolean;
										if (breakpoint.instructionReference) {
											// When available, match by instruction address
											match = (breakpoint.instructionReference === frame.instructionPointerReference);
										}
										else {
											// Match by source.  At least path and line must be defined and equal, but also match endline, column, and
											// endcolumn if available.
											match = (
												breakpoint.source !== undefined && breakpoint.source.path !== undefined && breakpoint.source.path === frame.source.path &&
												breakpoint.line !== undefined && breakpoint.line === frame.line &&
												breakpoint.endLine === frame.endLine &&
												breakpoint.column === frame.column &&
												breakpoint.endColumn === frame.endColumn);
										}

										// If so, execute the scriptpoint
										if (match) {
											// On successful execution, if the scriptpoint does not request to stop execution, and execution is not
											// already stopped, ask the debugger to continue
											let success = await executeScriptpoint(scriptpoint.script, session, frame.id);
											if (success && !scriptpoint.stop && !stepped && stopped.body.reason.includes('breakpoint')) {
												// 
												let continueArgs: DebugProtocol.ContinueArguments = { threadId: threadId };
												session.customRequest('continue', continueArgs);
											}
										}
									}
								}
								catch (e) {
									console.log('scriptpoints: checkScriptpoint() failed with "' + e + "'");
								}
							}
							else if (event.event === 'breakpoint') {
								// Get the scriptpoint list for the breakpoint's source
								let breakpointEvent = event as DebugProtocol.BreakpointEvent;
								let breakpoint = breakpointEvent.body.breakpoint;
								if (!breakpoint.source || !breakpoint.source.path || !breakpoint.id) {
									return; // todo: support source references
								}
								let source: ScriptpointSource | undefined;
								if (breakpoint.id) {
									source = idToSource.get(breakpoint.id);
								}
								else {
									source = sources.get(breakpoint.source.path);
								}
								if (!source) {
									return;
								}

								// Search the list for a matching ID and update the scriptpoint
								for (const scriptpoint of source.scriptpoints) {
									if (scriptpoint.breakpoint?.id === breakpoint.id) {
										scriptpoint.breakpoint = breakpoint;
										break;
									}
								}
							}
						}
					},

					onWillReceiveMessage(message: DebugProtocol.ProtocolMessage): void {
						if (message.type === 'request') {
							let request = message as DebugProtocol.Request;
							if (request.command === 'setBreakpoints') {
								// Find or create the source entry
								let setBreakpoints = request as DebugProtocol.SetBreakpointsRequest;
								let path = setBreakpoints.arguments.source.path;
								if (!path) {
									return; // todo: support source references
								}
								let source = sources.get(path);
								if (!source) {
									source = new ScriptpointSource();
									sources.set(path, source);
								}

								// Clear the scriptpoint list and save the request ID so that it can be
								// matched to a future response
								source.scriptpoints = [];
								source.setBreakpointsSeq = request.seq;

								// Convert logpoints with scripts to normal breakpoints, so that the debugger
								// will stop and provide an opportunity to execute the script.
								if (!setBreakpoints.arguments.breakpoints) {
									return;
								}
								for (let i = 0; i < setBreakpoints.arguments.breakpoints.length; i++) {
									// Check if it's a scriptpoint
									const breakpoint = setBreakpoints.arguments.breakpoints[i];
									if (!breakpoint.logMessage || breakpoint.logMessage.length === 0 || breakpoint.logMessage[0] !== '!') {
										continue;
									}

									// Check if execution should stop when hit
									let stop = (breakpoint.logMessage.length > 1 && breakpoint.logMessage[1] === '!');

									// Extract the script
									let match = breakpoint.logMessage.match(/!!?\s*(.*)/);
									if (!match || match.length < 2) {
										continue;
									}
									let script = match[1];

									// Add to the scriptpoint list
									source.scriptpoints.push(new Scriptpoint(i, script, stop));

									// Clear the log message
									breakpoint.logMessage = undefined;
								}
							}
							else if (['next', 'stepIn', 'stepOut'].includes(request.command)) {
								step = true;
							}
						}
					}
				};
			}
		}));
}

export function deactivate() { }
