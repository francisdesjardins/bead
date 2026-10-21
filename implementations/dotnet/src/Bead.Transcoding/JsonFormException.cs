namespace Bead.Transcoding;

/// <summary>
/// A refusal of Bead's mapping (transcoding 4 and 5): a request's body, query or variable it does
/// not read, which a gateway answers 400 <c>PAYLOAD_UNDECODABLE</c>, or a result it holds no form
/// of, 500. Its message is its own words, which a problem's <c>detail</c> carries; thrown by the
/// mapping alone, so that no exception of the platform's puts its words there. The TypeScript
/// side's <c>JsonFormError</c>.
/// </summary>
public sealed class JsonFormException : Exception
{
    /// <summary>A refusal, saying why.</summary>
    public JsonFormException(string message)
        : base(message)
    {
    }

    /// <summary>A refusal, saying why, of what <paramref name="innerException"/> refused first.</summary>
    public JsonFormException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
