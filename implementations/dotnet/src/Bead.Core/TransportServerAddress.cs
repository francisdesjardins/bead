namespace Bead;

/// <summary>Where a transport server listens, once started: whichever transport it is.</summary>
/// <param name="Address">Its address.</param>
/// <param name="Port">Its port.</param>
public readonly record struct TransportServerAddress(string Address, int Port);
