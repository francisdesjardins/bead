using System.Globalization;
using Hello;

// HelloService's C# server and client, as the TypeScript side's main.ts runs them: `serve`, on any
// free port, `serve <port>`, on the port given, and `call <port>`, a port its digits alone, at most
// 65535, a ushort; any other arguments, the usage, and exit 2.
return args switch
{
    ["serve"] => await Serving.Serve(0),
    ["serve", var port] when ushort.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var number) => await Serving.Serve(number),
    ["call", var port] when ushort.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var number) => await Calling.Call(number),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.Write("usage: hello serve [port] | hello call <port>\n");

    return 2;
}
