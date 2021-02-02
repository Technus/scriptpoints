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

function executeScriptpoint(message: string)
{
	let match = message.match(/!!?\s*(.*)/);
	if (!match || match.length < 2)
	{
		console.log('Error, could not execute script "' + message + "'");
		return;
	}
	let script = match[1];
	debug.activeDebugConsole.appendLine('script "' + script + '"');
}

export function activate(context: vscode.ExtensionContext)
{
	// Snoop on messages between vs code and the debugger to infer the active thread and stack frame
	context.subscriptions.push(debug.registerDebugAdapterTrackerFactory("*",
	{
		createDebugAdapterTracker: session =>
		{
			return {
				onWillStartSession: () =>
				{
					for (const breakpoint of debug.breakpoints)
					{
						console.log('bp: ' + breakpoint.id);
					}
				},
				
				onWillEndSession: () =>
				{
				},

				onDidSendMessage: async (message: DebugProtocol.ProtocolMessage) => 
				{
					let session = debug.activeDebugSession;
					if (!session)
					{
						return;
					}

					if (message.type === 'response')
					{
						// console.log('DAP response: ' + (message as DebugProtocol.Response).command);
					}
					else if (message.type === 'event')
					{
						let event = message as DebugProtocol.Event;
						if (event.event === 'stopped')
						{
							let stopped = event as DebugProtocol.StoppedEvent;
							if (stopped.body.reason === 'breakpoint')
							{
								// Get the top frame of the stopped thread
								let threadId = stopped.body.threadId ?? 0; // TODO what to use when no thread ID is specified?
								let stackArgs: DebugProtocol.StackTraceArguments = { threadId: threadId, startFrame: 0, levels: 1 };
								const stackTrace = await session.customRequest('stackTrace', stackArgs);// as DebugProtocol.StackTraceResponse;
								//if (!stackTrace.success || stackTrace.body.stackFrames.length === 0)
								// TODO it seems that at least the C++ debugger does not return a StackTraceResponse?
								// Or maybe session.customRequest() just returns the body from the response?
								if (!stackTrace.stackFrames || stackTrace.stackFrames.length === 0)
								{
									return;
								}

								const frame = stackTrace.stackFrames[0];
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
									if (location.uri.fsPath === frame.source?.path && location.range.contains(new Position(frame.line - 1, frame.column - 1)))
									{
										executeScriptpoint(breakpoint.logMessage);
										if (!isBreakScriptpoint(breakpoint.logMessage))
										{
											let continueArgs : DebugProtocol.ContinueArguments = { threadId: threadId };
											session.customRequest('continue', continueArgs);
										}
									}
								}
							}
						}
					}
				},

				onWillReceiveMessage(message: DebugProtocol.ProtocolMessage): void
				{
					if (message.type === 'request')
					{
						let request = message as DebugProtocol.Request;
						if (request.command === 'setBreakpoints')
						{
							let setBreakpoints = request as DebugProtocol.SetBreakpointsRequest;
							if (!setBreakpoints.arguments.breakpoints)
							{
								return;
							}
							for (const breakpoint of setBreakpoints.arguments.breakpoints)
							{
								if (isScriptpoint(breakpoint.logMessage))
								{
									breakpoint.logMessage = undefined;
								}
							}
						}
						// console.log('DAP request: ' + (message as DebugProtocol.Request).command);
					}
				}
			};
		}
	}));
}

export function deactivate() {}
