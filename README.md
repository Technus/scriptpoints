# Scriptpoints

This extension can make breakpoints run JavaScript when hit.  Just create a logpoint that begins with !, and the rest of the message is interpreted as JS.  You can also start with !! to make execution pause when the scriptpoint is hit.

## Environment

There are three useful functions available to your script:
* **log('message')** writes a line to the debug console.
* **command('commandName', ...args)** executes a VS Code command.
* **async evaluate('expression')** evaluates an expression in the context of the program being debugged and returns its value as a string, just as if the expression were entered in the watch window.  Note that because evaluate is **async**, you must write **await evaluate('expression')** to get the result of the evaluation.

## Uses

Scriptpoints let you write complex logging logic without needing to modify the code of the program you are debugging.  For instance, you could use it to log a message if a list contains a particular item.  Or you could log the square root of a variable instead of the variable itself.  Or you could send 2D points to a command that adds them to a graph.

Scriptpoints work even for debuggers that have not implemented logpoint support, like vscode-cpptools.  So, you can write *!log(async evaluate('myVariable'))* to get the equivalent of the logpoint *{myVariable}*.