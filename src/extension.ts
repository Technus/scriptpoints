import * as vscode from 'vscode';
import { BreakpointsChangeEvent, DebugSession, Position, window, debug } from 'vscode';
const { spawn } = require('child_process');
import { DebugProtocol } from 'vscode-debugprotocol';

class ScriptPoint
{
	constructor(path: string, position: Position)
	{
		this.path = path;
		this.position = position;
	}

	path: string;
	position: Position;
}

export function activate(context: vscode.ExtensionContext)
{
	let points: ScriptPoint[] = [];
	
	context.subscriptions.push(vscode.commands.registerCommand('breakpoint-scripts.AddScriptPoint', (uri: vscode.Uri) =>
	{
		if (!window.activeTextEditor)
		{
			window.showInformationMessage('Can\'t set scriptpoint: no active document');
			return;
		}
		points.push(new ScriptPoint(uri.fsPath, window.activeTextEditor.selection.active));
	}));

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
								let stackArgs: DebugProtocol.StackTraceArguments = { threadId: stopped.body.threadId ?? -1, startFrame: 0, levels: 1 };
								const stackTrace = await session.customRequest('stackTrace', stackArgs) as DebugProtocol.StackTraceResponse;
								if (stackTrace.success && stackTrace.body.stackFrames.length > 0)
								{
									//stackTrace.body.stackFrames[0]
									//debug.breakpoints
								}
							}
						}
						// console.log('DAP event: ' + (event).event);
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
							if (setBreakpoints.arguments.breakpoints)
							{
								for (const point of points)
								{
									if (setBreakpoints.arguments.source.path === point.path)
									{
										let breakpoint: DebugProtocol.SourceBreakpoint = {
											line: point.position.line
										};
										setBreakpoints.arguments.breakpoints.push(breakpoint);
									}
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
