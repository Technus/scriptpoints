import * as vscode from 'vscode';
import { Breakpoint, SourceBreakpoint, DebugSession, Position, window, debug } from 'vscode';
const { spawn } = require('child_process');
import { DebugProtocol } from 'vscode-debugprotocol';

// Log message beginning with ! is used as a scriptpoint
function isScriptpoint(message?: string)
{
	return (message && message.length > 0 && message[0] === '!');
}

// Scriptpoint beginning with !! breaks when hit
function isBreakScriptpoint(message: string)
{
	return (message.length > 2 && message[1] === '!');
}

// Executes a scriptpoint.  Returns true on success, false in case of error.
async function executeScriptpoint(message: string, session: DebugSession, frameId: number): Promise<boolean>
{
	return new Promise<boolean>(async (resolve, reject) =>
	{
		// Extract the script from the log string
		let f: Function;
		let match = message.match(/!!?\s*(.*)/);
		if (!match || match.length < 2)
		{
			console.log('Error, could not execute script "' + message + "'");
			resolve(false);
			return;
		}
		let script = match[1];

		// Set up the environment script environment
		let log = (message: string) => debug.activeDebugConsole.appendLine(message);
		let command = (command: string, ...args: any[]) => vscode.commands.executeCommand(command, ...args);
		let evaluate = async (expression: string) => 
		{
			const evaluateArgs: DebugProtocol.EvaluateArguments = { expression: expression, frameId: frameId };
			const response = await session.customRequest('evaluate', evaluateArgs);
			return response.result;
		};
		let memory = async (expression: string, size: number) =>
		{
			const evaluateArgs: DebugProtocol.EvaluateArguments = { expression: expression, frameId: frameId };
			const response = await session.customRequest('evaluate', evaluateArgs);
			const memoryArgs: DebugProtocol.ReadMemoryArguments = { memoryReference: response.memoryReference, offset: 0, count: size };
			const memory = await session.customRequest('readMemory', memoryArgs);
			return memory.data;
		};

		try
		{
			let f = Function('"use strict"; return async function(log, command, evaluate, memory){ ' + script + ' }')();
			await f(log, command, evaluate, memory);
		}
		catch (e)
		{
			let errorMessage = 'Scriptpoint exception "' + e + '" executing: "' + script + '"';
			debug.activeDebugConsole.appendLine('\u001b[31m' + errorMessage + '\u001b[0m');
			resolve(false);
			return;
		}

		resolve(true);
	});
}

export function activate(context: vscode.ExtensionContext)
{
	// Discussion in https://github.com/microsoft/vscode/issues/63444 says that you need to register for BreakpointsChangeEvent
	// in order for vscode.debug.breakpoints to be kept up to date.  That quote has been removed from the linked documentation,
	// but it appears to be true that without registering an event, vscodedebug.breakpoints is sometimes empty even after one of
	// the breakpoints has already been hit.
	context.subscriptions.push(debug.onDidChangeBreakpoints((e: vscode.BreakpointsChangeEvent) => {}));

	// Snoop on messages between vs code and the debugger to infer the active thread and stack frame
	context.subscriptions.push(debug.registerDebugAdapterTrackerFactory("*",
	{
		createDebugAdapterTracker: session =>
		{
			// Check if the thread is stopped at a scriptpoint, and executes it if so.
			// Returns true if a scriptpoint is executed successfully and does not request the program to break, else false.
			const checkAndExecuteScriptpoint = async (threadId: number): Promise<boolean> =>
			{
				return new Promise<boolean>(async (resolve, reject) =>
				{
					try
					{
						// Do a stack trace to find out where we are
						let stackArgs: DebugProtocol.StackTraceArguments = { threadId: threadId, startFrame: 0, levels: 1 };
						const stackTrace = await session.customRequest('stackTrace', stackArgs);
						if (!stackTrace.stackFrames || stackTrace.stackFrames.length === 0)
						{
							resolve(false);
							return;
						}

						const frame = stackTrace.stackFrames[0] as DebugProtocol.StackFrame;
						for (const breakpoint of debug.breakpoints)
						{
							// Find scriptpoints
							if (!breakpoint.logMessage || !isScriptpoint(breakpoint.logMessage))
							{
								continue;
							}

							// Check if it's a source breakpoint
							let location = (breakpoint as SourceBreakpoint).location;
							if (!location)
							{
								continue;
							}

							// Check if the breakpoint location matches the stopped thread's top frame
							// Note, vscode Location uses line and column numbers indexed from zero, while DAP seems to index from 1.
							// TODO - figure out how source references work
							if (location.uri.fsPath === frame.source?.path && location.range.contains(new Position(frame.line - 1, 0)))
							{
								let success = await executeScriptpoint(breakpoint.logMessage, session, frame.id);
								resolve(success && !isBreakScriptpoint(breakpoint.logMessage));
								return;
							}
						}
					}
					catch (e)
					{
						console.log('scriptpoints: checkScriptpoint() failed with "' + e + "'");
					}

					resolve(false);
				});
			};

			return {
				onWillStartSession: () =>
				{
				},
				
				onWillEndSession: () =>
				{
				},

				onDidSendMessage: async (message: DebugProtocol.ProtocolMessage) => 
				{
					if (message.type === 'event')
					{
						let event = message as DebugProtocol.Event;
						if (event.event === 'stopped')
						{
							let stopped = event as DebugProtocol.StoppedEvent;
							if (stopped.body.reason.includes('breakpoint'))
							{
								let threadId = stopped.body.threadId ?? 0; // TODO what to use when no thread ID is specified?
								if (await checkAndExecuteScriptpoint(threadId) && stopped.body.reason.includes('breakpoint'))
								{
									let continueArgs : DebugProtocol.ContinueArguments = { threadId: threadId };
									session.customRequest('continue', continueArgs);
								}
							}
						}
					}
				},

				onWillReceiveMessage(message: DebugProtocol.ProtocolMessage): void
				{
				}
			};
		}
	}));
}

export function deactivate() {}
