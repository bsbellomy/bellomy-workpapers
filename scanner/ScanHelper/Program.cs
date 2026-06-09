using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using NAPS2.Images;
using NAPS2.Images.Gdi;
using NAPS2.Pdf;
using NAPS2.Scan;

class Program
{
    static async Task<int> Main(string[] args)
    {
        var command = args.Length > 0 ? args[0] : "";
        try
        {
            using var ctx = new ScanningContext(new GdiImageContext());
            ctx.SetUpWin32Worker();
            var controller = new ScanController(ctx);

            return command switch
            {
                "list" => await ListDevices(controller, args),
                "scan" => await ScanDocument(ctx, controller, args),
                _      => Error($"Unknown command '{command}'. Use 'list' or 'scan'."),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(Json(new { ok = false, error = ex.Message }));
            return 1;
        }
    }

    // ── list ──────────────────────────────────────────────────────────────────

    static async Task<int> ListDevices(ScanController controller, string[] args)
    {
        var driver = ParseDriver(args);
        var devices = await controller.GetDeviceList(driver);
        var list = devices.Select(d => new { d.ID, d.Name }).ToList();
        Console.WriteLine(Json(new { ok = true, devices = list }));
        return 0;
    }

    // ── scan ──────────────────────────────────────────────────────────────────

    static async Task<int> ScanDocument(ScanningContext ctx, ScanController controller, string[] args)
    {
        if (args.Length < 2)
            return Error("Usage: scan <dest-folder> [--device <id>] [--ui] [--driver twain|wia] [--dpi N] [--color|--grayscale|--bw]");

        var destFolder  = args[1];
        var deviceId    = GetFlag(args, "--device");
        var useNativeUI = args.Contains("--ui");
        var driver      = ParseDriver(args);

        // Resolution — default 200 dpi (good quality, much smaller than 300)
        var dpiStr = GetFlag(args, "--dpi");
        var dpi    = dpiStr != null && int.TryParse(dpiStr, out var d) ? d : 200;

        // Color mode — default grayscale (tax docs don't need color)
        BitDepth bitDepth;
        if (args.Contains("--color"))
            bitDepth = BitDepth.Color;
        else if (args.Contains("--bw"))
            bitDepth = BitDepth.BlackAndWhite;
        else
            bitDepth = BitDepth.Grayscale; // default

        Directory.CreateDirectory(destFolder);

        // ── resolve device ────────────────────────────────────────────────────
        var devices = await controller.GetDeviceList(driver);
        ScanDevice? device;

        if (deviceId != null)
        {
            device = devices.FirstOrDefault(d =>
                d.ID == deviceId ||
                d.Name.Contains(deviceId, StringComparison.OrdinalIgnoreCase));

            if (device == null)
                return Error($"Device not found: {deviceId}");
        }
        else
        {
            device = devices.FirstOrDefault();
            if (device == null)
                return Error("No TWAIN scanner devices found. Make sure your scanner is connected and its driver is installed.");
        }

        // ── scan ──────────────────────────────────────────────────────────────
        // When native UI is shown, PaperStream's profile controls all settings.
        // Only apply programmatic DPI/color when running silent (quick scan).
        var options = new ScanOptions
        {
            Device      = device,
            Driver      = driver,
            UseNativeUI = useNativeUI,
            Dpi         = useNativeUI ? 0   : dpi,      // 0 = use driver default
            BitDepth    = useNativeUI ? BitDepth.Color : bitDepth,  // Color = driver default
        };

        var images = new List<ProcessedImage>();
        await foreach (var image in controller.Scan(options))
        {
            images.Add(image);
            Console.Error.WriteLine($"PAGE:{images.Count}"); // progress signal to Electron
        }

        if (images.Count == 0)
            return Error("No pages were scanned.");

        // ── save PDF ──────────────────────────────────────────────────────────
        var ts   = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var dest = Path.Combine(destFolder, $"Scan_{ts}.pdf");
        var n    = 2;
        while (File.Exists(dest))
        {
            dest = Path.Combine(destFolder, $"Scan_{ts}_{n}.pdf");
            n++;
        }

        var exportParams = new PdfExportParams
        {
            Compat = PdfCompat.Default,
        };

        var exporter = new PdfExporter(ctx);
        await exporter.Export(dest, images, exportParams);
        foreach (var img in images) img.Dispose();

        Console.WriteLine(Json(new { ok = true, path = dest, name = Path.GetFileName(dest), pages = images.Count }));
        return 0;
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    static int Error(string message)
    {
        Console.Error.WriteLine(Json(new { ok = false, error = message }));
        return 1;
    }

    static string Json(object o) =>
        JsonSerializer.Serialize(o, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

    static string? GetFlag(string[] args, string flag)
    {
        var idx = Array.IndexOf(args, flag);
        return idx >= 0 && idx + 1 < args.Length ? args[idx + 1] : null;
    }

    static Driver ParseDriver(string[] args) =>
        GetFlag(args, "--driver")?.ToLower() switch { "wia" => Driver.Wia, _ => Driver.Twain };
}
