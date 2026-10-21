using System.Text;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="HttpProblems"/>: a failure answered as a problem of RFC 9457, its status by where its
/// code arose, its members canonical, a <c>PAYLOAD_INVALID</c>'s violations as its <c>errors</c>
/// (transcoding 7). The twins of the TypeScript side's <c>problems.test.ts</c>.
/// </summary>
public sealed class ProblemsTests
{
    private static ProblemContext At(FailureArising arose)
    {
        return new ProblemContext { Arose = arose, ProblemTypes = "https://example.com/problems/", Failures = RouteOf("fail").Failures };
    }

    [Fact]
    public void Answers_each_protocol_code_with_its_status_by_where_it_arose_and_its_problem()
    {
        // * one code, two statuses: the caller's 413 before it went, the server's answer the gateway could not take 502
        Assert.Equal(413, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadTooLarge), At(FailureArising.Client)).Status);
        Assert.Equal(502, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadTooLarge), At(FailureArising.Answer)).Status);
        Assert.Equal(400, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable), At(FailureArising.Gateway)).Status);
        Assert.Equal(502, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable), At(FailureArising.Server)).Status);
        Assert.Equal(400, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable), At(FailureArising.Server) with { Encoding = HttpEncoding.Json }).Status);
        Assert.Equal(500, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.CredentialUnsupported), At(FailureArising.Server)).Status);
        Assert.Equal(501, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.ProcedureUnknown), At(FailureArising.Server)).Status);

        var required = HttpProblems.Of(Failure.OfProtocol(ProtocolCode.SessionRequired, "the credential does not hold"), At(FailureArising.Server) with { Credential = true });

        Assert.Equal(401, required.Status);
        Assert.Equal("Bearer error=\"invalid_token\"", required.Fields["www-authenticate"]);
        Assert.Equal(
            "{\"code\":32,\"detail\":\"the credential does not hold\",\"scope\":\"protocol\",\"status\":401,\"title\":\"SESSION_REQUIRED\",\"type\":\"tag:francisdesjardins.ca,2026:bead/SESSION_REQUIRED\"}",
            Text(required.Body));
        Assert.Equal("1", HttpProblems.Of(Failure.OfProtocol(ProtocolCode.CapacityExceeded), At(FailureArising.Server)).Fields["retry-after"]);

        // an application failure under its problem types, by its catalogue's name
        Assert.Equal(
            "{\"code\":1,\"detail\":\"no\",\"scope\":\"application\",\"status\":400,\"title\":\"REFUSED\",\"type\":\"https://example.com/problems/REFUSED\"}",
            Text(HttpProblems.Of(Failure.OfApplication(1, "no"), At(FailureArising.Server)).Body));

        // a failure of the gateway's own is about:blank, titled by its status's phrase
        Assert.Equal(
            "{\"detail\":\"no answer within 5000 ms\",\"status\":504,\"title\":\"Gateway Timeout\",\"type\":\"about:blank\"}",
            Text(HttpProblems.Own(OwnFailure.Timeout, ("no answer within 5000 ms", "Bearer")).Body));
    }

    [Fact]
    public void Writes_PAYLOAD_INVALID_s_violations_as_errors_each_pointer_by_JSON_names()
    {
        var echo = RouteOf("echo");
        var detail = string.Join('\n', [
            "{\"fieldPath\":\"labels[\\\"a/b~c d\\\"]\",\"forKey\":true,\"message\":\"short\",\"ruleId\":\"string.min_len\"}",
            "{\"fieldPath\":\"inners[1].name\",\"message\":\"short\",\"ruleId\":\"string.min_len\"}",
            "{\"bounds\":{\"lte\":10},\"fieldPath\":\"an_int32\",\"ruleId\":\"int32.lte\"}",
            "{\"more\":3}",
        ]);
        var problem = HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadInvalid, detail), At(FailureArising.Server) with
        {
            Request = echo.Request.Descriptor,
            Rule = echo.Routes[0],
        });

        Assert.Equal(422, problem.Status);
        Assert.Equal(
            "{\"code\":52,\"errors\":[{\"detail\":\"short\",\"fieldPath\":\"labels[\\\"a/b~c d\\\"]\",\"forKey\":true,\"pointer\":\"#/labels/a~1b~0c%20d\",\"ruleId\":\"string.min_len\"},{\"detail\":\"short\",\"fieldPath\":\"inners[1].name\",\"pointer\":\"#/inners/1/name\",\"ruleId\":\"string.min_len\"},{\"bounds\":{\"lte\":10},\"detail\":\"must be less than or equal to 10\",\"fieldPath\":\"an_int32\",\"pointer\":\"#/anInt32\",\"ruleId\":\"int32.lte\"}],\"more\":3,\"scope\":\"protocol\",\"status\":422,\"title\":\"PAYLOAD_INVALID\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_INVALID\"}",
            Encoding.UTF8.GetString(problem.Body.Span));
    }
}
