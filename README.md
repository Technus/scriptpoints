# Scriptpoints

This extension can make breakpoints run JavaScript when hit.  Just create a logpoint that begins with !, and the rest of the message is interpreted as JS.  You can also start with !! to make execution pause when the scriptpoint is hit.

## Environment

There are some useful functions available to your script:
* **log(message: string)** writes a line to the debug console.
* **command(command: string, ...args)** executes a VS Code command with the provided arguments.
* **async evaluate(expression: string): string** evaluates an expression in the context of the program being debugged and returns its value, the same as if you entered the expression in the watch panel.
* **async memory(expression: string, bytes: number): string** evaluates an expression and returns a chunk of memory beginning at the address of the value in base64. This only works in languages that support reading memory, like C++.

Note that evaluate() and memory() are **async** functions, because they need to use async APIs for communicating with the debugger.  So you need to use them with **await**.  For example, you should write *log(await evaluate('myVariable'))*, as *log(evaluate('myVariable'))* will not work.

## Uses

Scriptpoints let you write complex logging logic without needing to modify the code of the program you are debugging.  For instance, you could use it to log a message if a list contains a particular item.  Or you could log the square root of a variable instead of the variable itself.  Or you could send 2D points to a command that adds them to a graph.

Scriptpoints work even for debuggers that have not implemented logpoint support, like vscode-cpptools.  So, you can write *!log(async evaluate('myVariable'))* to get the equivalent of the logpoint *{myVariable}*.

## Limitations

* If your program is paused and you step over a line of code that has a scriptpoint on it, execution will pause again at that scriptpoint.
* So far this extension has only been tested with C++ and JS. While it should work with any language, there could be bugs if those languages' debug adapters work too much differently from the ones that I tried.
