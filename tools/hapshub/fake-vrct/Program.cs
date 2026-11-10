// Speaks VRCT's engine protocol: one JSON request per line on stdin ({"endpoint", "data": base64 of JSON}), one JSON
// answer or event per line on stdout ({"status", "endpoint", "result"}). Writes every request it gets to the file named
// by FAKE_VRCT_LOG, so a test can see what the page asked for. Ends when the watchdog isn't fed for 12 seconds.

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var log = Environment.GetEnvironmentVariable("FAKE_VRCT_LOG");
var output = Console.Out;
var outLock = new object();
void Emit(int status, string endpoint, JsonNode? result)
{
    var line = new JsonObject { ["status"] = status, ["endpoint"] = endpoint, ["result"] = result?.DeepClone() }.ToJsonString();
    lock (outLock) { output.WriteLine(line); output.Flush(); }
}
JsonObject Lang(string language, string country, bool enable = true) => new() { ["language"] = language, ["country"] = country, ["enable"] = enable };

var data = new Dictionary<string, JsonNode?>
{
    ["selected_tab_no"] = "1",
    ["selectable_language_list"] = new JsonArray(Lang("English", "United States"), Lang("English", "United Kingdom"), Lang("Hebrew", "Israel"), Lang("Japanese", "Japan")),
    ["selected_your_languages"] = new JsonObject { ["1"] = new JsonObject { ["1"] = Lang("English", "United States") } },
    ["selected_target_languages"] = new JsonObject { ["1"] = new JsonObject { ["1"] = Lang("Japanese", "Japan"), ["2"] = Lang("English", "United States", false), ["3"] = Lang("English", "United States", false) } },
    ["selectable_translation_engines"] = new JsonArray("DeepL", "Google", "CTranslate2"),
    ["selected_translation_engines"] = new JsonObject { ["1"] = "CTranslate2" },
    ["selectable_transcription_engines"] = new JsonArray("Google", "Whisper"),
    ["selected_transcription_engine"] = "Google",
    ["selectable_mic_device_list"] = new JsonArray("Test Microphone", "Other Microphone"),
    ["selected_mic_device"] = "Test Microphone",
    ["selectable_speaker_device_list"] = new JsonArray("Test Speakers [Loopback]"),
    ["selected_speaker_device"] = "Test Speakers [Loopback]",
    ["send_message_to_vrc"] = true,
    ["send_only_translated_messages"] = false,
    ["overlay_small_log"] = false,
};
string Target() => data["selected_target_languages"]?["1"]?["1"]?["language"]?.GetValue<string>() ?? "?";

var lastFeed = DateTime.UtcNow;
var started = DateTime.UtcNow;
new Thread(() =>
{
    for (var step = 1; step <= 4; step++) { Thread.Sleep(150); Emit(200, "/run/initialization_progress", step); }
    var snapshot = new JsonObject();
    foreach (var (key, value) in data) snapshot["/get/data/" + key] = value?.DeepClone();
    Emit(200, "/run/initialization_complete", snapshot);
}) { IsBackground = true }.Start();
new Thread(() =>
{
    while (true)
    {
        Thread.Sleep(500);
        if (DateTime.UtcNow - lastFeed > TimeSpan.FromSeconds(12)) { Emit(348, "", null); Environment.Exit(3); }
    }
}) { IsBackground = true }.Start();

string? request;
var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
while ((request = input.ReadLine()) != null)
{
    JsonNode? parsed;
    try { parsed = JsonNode.Parse(request); } catch (JsonException) { continue; }
    var endpoint = parsed?["endpoint"]?.GetValue<string>() ?? "";
    JsonNode? payload = null;
    if (parsed?["data"]?.GetValue<string>() is { } encoded)
        payload = JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(encoded)));
    if (!string.IsNullOrEmpty(log) && endpoint != "/run/feed_watchdog")
        File.AppendAllText(log, endpoint + " " + (payload?.ToJsonString() ?? "") + "\n");

    if (endpoint == "/run/feed_watchdog") { lastFeed = DateTime.UtcNow; Emit(200, endpoint, true); }
    else if (endpoint == "/run/shutdown") { Emit(200, endpoint, true); Environment.Exit(0); }
    else if (endpoint.StartsWith("/set/data/")) { data[endpoint[10..]] = payload?.DeepClone(); Emit(200, endpoint, payload); }
    else if (endpoint.StartsWith("/get/data/")) Emit(200, endpoint, data.GetValueOrDefault(endpoint[10..])?.DeepClone());
    else if (endpoint.StartsWith("/set/enable/"))
    {
        Emit(200, endpoint, true);
        if (endpoint == "/set/enable/transcription_send")
            Emit(200, "/run/transcription_send_mic_message", new JsonObject
            {
                ["original"] = new JsonObject { ["message"] = "hello from the mic", ["transliteration"] = new JsonArray() },
                ["translations"] = new JsonArray(new JsonObject { ["message"] = $"[{Target()}] hello from the mic", ["transliteration"] = new JsonArray() }),
            });
    }
    else if (endpoint.StartsWith("/set/disable/")) Emit(200, endpoint, false);
    else if (endpoint == "/run/send_message_box")
    {
        var message = payload?["message"]?.GetValue<string>() ?? "";
        Emit(200, endpoint, new JsonObject
        {
            ["id"] = payload?["id"]?.DeepClone(),
            ["original"] = new JsonObject { ["message"] = message, ["transliteration"] = new JsonArray() },
            ["translations"] = new JsonArray(new JsonObject { ["message"] = $"[{Target()}] {message}", ["transliteration"] = new JsonArray() }),
        });
    }
    else Emit(404, endpoint, "Invalid endpoint");
}
