"""The interop service's API, its one service in its blueprint (decision 0022): its id, and each
procedure's id by its name, which make_conversations.py and make_transports.py both read."""
import json

from conformance import ROOT

with open(ROOT + 'interop-blueprint.json', encoding='utf8') as file:
    API = json.load(file)['services'][0]

SERVICE_ID = API['serviceId']
PROCEDURES = {procedure['procedureName']: procedure['procedureId'] for procedure in API['procedures']}
