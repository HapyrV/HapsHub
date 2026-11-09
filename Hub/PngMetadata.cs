using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HapsHub.Core;

public sealed record PhotoPerson(string Id, string Name);

public sealed record PhotoMetadata(
    string Application, string AuthorId, string AuthorName, string WorldId, string WorldName, string Location,
    IReadOnlyList<PhotoPerson> Players);

/// <summary>Whether new screenshots get the world and people written into the file. Off until you turn it on.</summary>
public sealed class PhotoMetadataModule : IHubModule
{
    public const string ModuleId = "hub.photo-metadata";
    private const string WriteKey = "write";
    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "Screenshot details";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(WriteKey, "Write the world and people into new screenshots, the way VRCX does", HubSettingKind.Toggle, "false"),
    };

    public bool WriteEnabled => string.Equals(_context?.GetSetting(WriteKey), "true", StringComparison.OrdinalIgnoreCase);

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _context = null;
        return Task.CompletedTask;
    }
}

/// <summary>
/// Reads and writes the text kept inside PNG files: what VRCX and HapsHub write, and VRChat's own
/// details. A write replaces the whole file at once and keeps its dates, so a failure leaves the picture as it was.
/// </summary>
public static class PngMetadata
{
    private const string DescriptionKeyword = "Description";
    private const string XmpKeyword = "XML:com.adobe.xmp";
    private const int MaxTextChunk = 16 * 1024 * 1024;
    private static readonly byte[] Signature = { 137, 80, 78, 71, 13, 10, 26, 10 };
    private static readonly uint[] CrcTable = MakeCrcTable();

    private static uint[] MakeCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }

    private static uint Crc(byte[] data, int offset, int count)
    {
        var c = 0xFFFFFFFF;
        for (var i = offset; i < offset + count; i++) c = CrcTable[(c ^ data[i]) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFF;
    }

    private static uint ReadUInt32(byte[] data, int offset = 0) =>
        (uint)(data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]);

    private static void WriteUInt32(Stream stream, uint value)
    {
        stream.WriteByte((byte)(value >> 24));
        stream.WriteByte((byte)(value >> 16));
        stream.WriteByte((byte)(value >> 8));
        stream.WriteByte((byte)value);
    }

    /// <summary>Every text entry in the file by keyword. It seeks past the picture itself, so it's quick on big files.</summary>
    public static IReadOnlyDictionary<string, string> ReadTexts(string path)
    {
        var texts = new Dictionary<string, string>();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var head = new byte[8];
        if (stream.Read(head, 0, 8) != 8 || !head.SequenceEqual(Signature)) return texts;
        var header = new byte[8];
        while (stream.Read(header, 0, 8) == 8)
        {
            var length = ReadUInt32(header);
            var type = Encoding.ASCII.GetString(header, 4, 4);
            if (type == "IEND" || length > int.MaxValue || stream.Position + length + 4 > stream.Length) break;
            if ((type == "tEXt" || type == "iTXt" || type == "zTXt") && length <= MaxTextChunk)
            {
                var data = new byte[length];
                if (stream.Read(data, 0, data.Length) != data.Length) break;
                var entry = ParseTextChunk(type, data);
                if (entry != null) texts.TryAdd(entry.Value.Keyword, entry.Value.Text);
                stream.Seek(4, SeekOrigin.Current);
            }
            else
            {
                stream.Seek(length + 4L, SeekOrigin.Current);
            }
        }
        return texts;
    }

    private static (string Keyword, string Text)? ParseTextChunk(string type, byte[] data)
    {
        var keywordEnd = Array.IndexOf(data, (byte)0);
        if (keywordEnd <= 0) return null;
        var keyword = Encoding.Latin1.GetString(data, 0, keywordEnd);
        try
        {
            switch (type)
            {
                case "tEXt":
                    return (keyword, Encoding.Latin1.GetString(data, keywordEnd + 1, data.Length - keywordEnd - 1));
                case "zTXt":
                    return (keyword, Encoding.Latin1.GetString(Inflate(data, keywordEnd + 2)));
                default:
                    var compressed = data[keywordEnd + 1] == 1;
                    var languageEnd = Array.IndexOf(data, (byte)0, keywordEnd + 3);
                    if (languageEnd < 0) return null;
                    var translatedEnd = Array.IndexOf(data, (byte)0, languageEnd + 1);
                    if (translatedEnd < 0) return null;
                    var textStart = translatedEnd + 1;
                    var bytes = compressed ? Inflate(data, textStart) : data[textStart..];
                    return (keyword, Encoding.UTF8.GetString(bytes));
            }
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or ArgumentException or IndexOutOfRangeException)
        {
            return null; // One bad entry must not hide the rest.
        }
    }

    private static byte[] Inflate(byte[] data, int offset)
    {
        using var input = new MemoryStream(data, offset, data.Length - offset);
        using var zlib = new ZLibStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int read;
        while ((read = zlib.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, read);
            if (output.Length > MaxTextChunk) throw new InvalidDataException("text is too long");
        }
        return output.ToArray();
    }

    /// <summary>What the file says about itself: VRCX's or HapsHub's details first, then VRChat's own. Null if nothing.</summary>
    public static PhotoMetadata? Read(string path)
    {
        var texts = ReadTexts(path);
        if (texts.TryGetValue(DescriptionKeyword, out var description))
        {
            var parsed = ParseJson(description);
            if (parsed != null) return parsed;
        }
        return texts.TryGetValue(XmpKeyword, out var xmp) ? ParseXmp(xmp) : null;
    }

    public static PhotoMetadata? ParseJson(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            static string S(JsonElement parent, string name) =>
                parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
            var author = root.TryGetProperty("author", out var a) ? a : default;
            var world = root.TryGetProperty("world", out var w) ? w : default;
            var players = new List<PhotoPerson>();
            if (root.TryGetProperty("players", out var list) && list.ValueKind == JsonValueKind.Array)
                foreach (var player in list.EnumerateArray())
                    players.Add(new PhotoPerson(S(player, "id"), S(player, "displayName")));
            var worldId = S(world, "id");
            if (worldId.Length == 0 && players.Count == 0 && S(author, "id").Length == 0) return null;
            return new PhotoMetadata(S(root, "application"), S(author, "id"), S(author, "displayName"), worldId, S(world, "name"), S(world, "instanceId"), players);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static PhotoMetadata? ParseXmp(string xml)
    {
        static string Tag(string text, string name)
        {
            var match = Regex.Match(text, $@"<{Regex.Escape(name)}>([^<]*)</{Regex.Escape(name)}>");
            return match.Success ? System.Net.WebUtility.HtmlDecode(match.Groups[1].Value) : "";
        }
        var worldId = Tag(xml, "vrc:WorldID");
        var authorId = Tag(xml, "vrc:AuthorID");
        if (worldId.Length == 0 && authorId.Length == 0) return null;
        var authorName = Tag(xml, "xmp:Author");
        return new PhotoMetadata("VRChat", authorId, authorName, worldId, Tag(xml, "vrc:WorldDisplayName"), "", Array.Empty<PhotoPerson>());
    }

    public static string ToJson(PhotoMetadata metadata) => JsonSerializer.Serialize(new
    {
        application = "HapsHub",
        version = 1,
        author = new { id = metadata.AuthorId, displayName = metadata.AuthorName },
        world = new { name = metadata.WorldName, id = metadata.WorldId, instanceId = metadata.Location },
        players = metadata.Players.Select(p => new { id = p.Id, displayName = p.Name }),
    });

    /// <summary>
    /// Adds the details to a PNG. False, and nothing changed, if the file isn't a whole PNG or
    /// already has details from another app.
    /// </summary>
    public static bool Write(string path, PhotoMetadata metadata)
    {
        var original = File.ReadAllBytes(path);
        var ihdrEnd = FindIhdrEnd(original);
        if (ihdrEnd < 0 || !IsWhole(original)) return false;
        if (ReadTexts(path).ContainsKey(DescriptionKeyword)) return false;

        using var output = new MemoryStream(original.Length + 1024);
        output.Write(original, 0, ihdrEnd);
        WriteTextChunk(output, DescriptionKeyword, ToJson(metadata));
        output.Write(original, ihdrEnd, original.Length - ihdrEnd);

        var created = File.GetCreationTimeUtc(path);
        var modified = File.GetLastWriteTimeUtc(path);
        AtomicFile.WriteAllBytes(path, output.ToArray());
        File.SetCreationTimeUtc(path, created);
        File.SetLastWriteTimeUtc(path, modified);
        return true;
    }

    private static int FindIhdrEnd(byte[] data)
    {
        if (data.Length < 33 || !data.AsSpan(0, 8).SequenceEqual(Signature)) return -1;
        if (Encoding.ASCII.GetString(data, 12, 4) != "IHDR") return -1;
        var length = ReadUInt32(data, 8);
        return length > 1024 ? -1 : 8 + 8 + (int)length + 4;
    }

    private static bool IsWhole(byte[] data)
    {
        long position = 8;
        while (position + 12 <= data.Length)
        {
            var length = (long)ReadUInt32(data, (int)position);
            if (Encoding.ASCII.GetString(data, (int)position + 4, 4) == "IEND") return true;
            position += 12 + length;
        }
        return false;
    }

    private static void WriteTextChunk(Stream stream, string keyword, string text)
    {
        using var body = new MemoryStream();
        body.Write(Encoding.ASCII.GetBytes("iTXt"));
        body.Write(Encoding.Latin1.GetBytes(keyword));
        body.Write(new byte[] { 0, 0, 0, 0, 0 }); // End of keyword, not compressed, method, no language, no translation.
        body.Write(Encoding.UTF8.GetBytes(text));
        var bytes = body.ToArray();
        WriteUInt32(stream, (uint)(bytes.Length - 4));
        stream.Write(bytes, 0, bytes.Length);
        WriteUInt32(stream, Crc(bytes, 0, bytes.Length));
    }
}
