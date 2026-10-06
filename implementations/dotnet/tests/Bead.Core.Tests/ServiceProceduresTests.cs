namespace Bead.Tests;

/// <summary>
/// The service layer's descriptors and their rules of admission: the twins of the TypeScript side's
/// <c>descriptors.test.ts</c>.
/// </summary>
public sealed class ServiceProceduresTests
{
    // constants

    private static readonly Procedure Echo = new() { ServiceId = 8, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 1 };

    private static readonly ProcedureBindings<string, string> Bindings = new()
    {
        Admission = AdmissionRule.None,
        Request = PayloadCodecs.Text,
        Result = PayloadCodecs.Text,
    };

    private static readonly ProcedureBindings<string, string, string> NotifyingBindings = new()
    {
        Admission = AdmissionRule.None,
        Notification = PayloadCodecs.Text,
        Request = PayloadCodecs.Text,
        Result = PayloadCodecs.Text,
    };

    // definition

    [Fact]
    public void Sets_a_request_s_call_a_notifying_request_s_and_a_command_s()
    {
        Assert.Equal(ProcedureCall.Request, new RequestProcedure<GreeterProcedures, string, string, NoFailure>(Echo, Bindings).Procedure.Call);
        Assert.Equal(ProcedureCall.Notifies, new RequestProcedure<GreeterProcedures, string, string, string, NoFailure>(Echo, NotifyingBindings).Procedure.Call);
        Assert.Equal(ProcedureCall.Command, new CommandProcedure<GreeterProcedures, string, string, NoFailure>(Echo, Bindings).Procedure.Call);

        // a procedure that states its call already keeps it, and every other member
        Assert.Equal(
            Echo with { Call = ProcedureCall.Command },
            new CommandProcedure<GreeterProcedures, string, string, NoFailure>(Echo with { Call = ProcedureCall.Command }, Bindings).Procedure);
    }

    [Fact]
    public void Refuses_a_procedure_that_states_another_call()
    {
        Assert.Contains("is a command, where its descriptor describes a request", Assert.Throws<ArgumentException>(() =>
        {
            return new RequestProcedure<GreeterProcedures, string, string, NoFailure>(Echo with { Call = ProcedureCall.Command }, Bindings);
        }).Message, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() =>
        {
            return new RequestProcedure<GreeterProcedures, string, string, string, NoFailure>(Echo with { Call = ProcedureCall.Request }, NotifyingBindings);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new CommandProcedure<GreeterProcedures, string, string, NoFailure>(Echo with { Call = ProcedureCall.Notifies }, Bindings);
        });
    }

    [Fact]
    public void Refuses_a_codec_missing()
    {
        Assert.Throws<ArgumentNullException>(() =>
        {
            return new RequestProcedure<GreeterProcedures, string, string, NoFailure>(Echo, Bindings with { Request = null! });
        });
        Assert.Throws<ArgumentNullException>(() =>
        {
            return new CommandProcedure<GreeterProcedures, string, string, NoFailure>(Echo, Bindings with { Result = null! });
        });
        Assert.Throws<ArgumentNullException>(() =>
        {
            return new RequestProcedure<GreeterProcedures, string, string, string, NoFailure>(Echo, NotifyingBindings with { Notification = null! });
        });
    }

    [Fact]
    public void Makes_a_rule_of_every_call_a_session_or_a_hook_by_its_name()
    {
        Assert.Equal((null, null, "loud"), (AdmissionRule.None.HookName, AdmissionRule.Session.HookName, AdmissionRule.Hook("loud").HookName));
        Assert.Equal(AdmissionRule.Hook("loud"), AdmissionRule.Hook("loud"));
        Assert.NotEqual(AdmissionRule.None, AdmissionRule.Session);
        Assert.Throws<ArgumentException>(() =>
        {
            return AdmissionRule.Hook("");
        });
    }
}
