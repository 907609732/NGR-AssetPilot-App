$ErrorActionPreference = 'Stop'
# Uses Windows SendInput; no keyboard events or clicks. EOF stops the helper if the app exits.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class NgrMouseAwake {
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size, time; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput {
        public int dx, dy; public uint data, flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion value; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    public static void Run() {
        // Dedicated thread avoids synchronous Console.In implementations blocking the motion loop.
        bool stopped = false;
        var reader = new Thread(() => { Console.ReadLine(); Volatile.Write(ref stopped, true); });
        reader.IsBackground = true;
        reader.Start();
        Console.WriteLine("READY"); Console.Out.Flush();
        int direction = 1;
        var lastMove = System.Diagnostics.Stopwatch.StartNew();
        while (!Volatile.Read(ref stopped)) {
            Thread.Sleep(1000);
            if (Volatile.Read(ref stopped) || lastMove.ElapsedMilliseconds < 30000) continue;
            var info = new LastInput { size = (uint)Marshal.SizeOf(typeof(LastInput)) };
            if (!GetLastInputInfo(ref info)) throw new Exception("IDLE_QUERY_FAILED");
            if (unchecked((uint)Environment.TickCount - info.time) < 10000) continue;
            bool held = false;
            foreach (int key in new [] { 1, 2, 4, 5, 6, 16, 17, 18 })
                held |= (GetAsyncKeyState(key) & 0x8000) != 0;
            if (held) continue;
            var input = new Input { type = 0, value = new InputUnion { mouse = new MouseInput { dx = direction, flags = 1 } } };
            if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("MOUSE_INPUT_FAILED");
            Console.WriteLine("MOVED"); Console.Out.Flush();
            direction = -direction;
            lastMove.Restart();
        }
    }
}
'@
[NgrMouseAwake]::Run()
