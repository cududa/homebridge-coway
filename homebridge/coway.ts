import { Logging } from "homebridge";
import { CowayConfig } from "./interfaces/config";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { Constants, Field, IoCareEndpoint, URL } from "./enumerations";
import Utils from "./utils";
import { URLSearchParams } from "url";
import { AccessTokenRequest, DeviceUpdateCommand, IoCarePayloadRequest } from "./interfaces/requests";
import { Device } from "./interfaces/device";

export interface AccessToken {
    accessToken: string;
    refreshToken: string;
}

export interface Session {
    session: string;
    cookies: string;
}

export interface PayloadCommand {
    key: Field;
    value: string;
}

export interface LogInRequest {
    clientName: "IOCARE";
    uiLocales: "en-US";
    isAosApp: true;
    isIosApp: false;
    termAgreementStatus: "";
    idp: "";
    username: string;
    password: string;
    rememberMe: "on";
}

export interface PasswordUpdateRequest {
    cmd: "change_next_time";
    checkPasswordNeededYn: "Y";
    current_password: "";
    new_password: "";
    new_password_confirm: "";
}

export class CowayService {

    constructor(private readonly log: Logging) {
    }

    async signIn(config?: CowayConfig): Promise<AccessToken | undefined> {
        if (!config) {
            return undefined;
        }
        const session = await this.parseSession();
        const authenticationCode = await this.authenticate({
            clientName: "IOCARE",
            uiLocales: "en-US",
            isAosApp: true,
            isIosApp: false,
            termAgreementStatus: "",
            idp: "",
            username: config.username,
            password: config.password,
            rememberMe: "on"
        }, session);
        return await this.getAccessTokens(authenticationCode);
    }

    private async parseSession(): Promise<Session> {
        const params = {
            auth_type: "0",
            response_type: "code",
            client_id: Constants.CLIENT_ID,
            ui_locales: "en-US",
            dvc_cntry_id: "US",
            redirect_uri: URL.NEW_IOCARE_REDIRECT_URL,
        };
        const queryString = new URLSearchParams(params).toString();

        // Make the GET request to get an initial session
        const response = await this.wrapGet(`${URL.NEW_SIGN_IN_URL}?${queryString}`)
            .catch(error => error.response);

        return {
            session: this.parseSessionCode(response),
            cookies: Utils.parseSetCookies(response.headers["set-cookie"]),
        };
    }

    private parseSessionCode(response: any): string {
        // Regex to extract the session_code parameter from the returned HTML
        const matches = response.data.match(/(action=")(https:\/\/.*)(\?session_code=)(.*)(" )/);
        // Replace HTML-encoded ampersands
        return matches[matches.length - 2].replaceAll("&amp;", "&");
    }

    private async authenticate(request: LogInRequest | PasswordUpdateRequest, session: Session): Promise<string> {
        const encoded = new URLSearchParams(request as any).toString();
        const response = await this.wrapPost(
            `${URL.NEW_AUTHENTICATE_URL}?session_code=${session.session}`,
            encoded,
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": session.cookies,
                }
            }
        ).catch(error => error.response);

        // If we still haven't hit the final redirect_bridge, bypass the password page
        if (response.request.path.indexOf("redirect_bridge.html") === -1) {
            return this.authenticate({
                cmd: "change_next_time",
                checkPasswordNeededYn: "Y",
                current_password: "",
                new_password: "",
                new_password_confirm: ""
            }, {
                session: this.parseSessionCode(response),
                cookies: session.cookies
            });
        } else {
            // Extract the 'code' query param from final redirect
            const path = response.request.path.split('?')[1];
            const splits = path.split('&');
            const dicts: { [key: string]: string } = {};
            for (let i = 0; i < splits.length; i++) {
                const kv = splits[i].split('=');
                dicts[kv[0]] = kv[1];
            }
            return dicts["code"];
        }
    }

    private async getAccessTokens(authenticationCode: string): Promise<AccessToken> {
        const accessTokenRequest: AccessTokenRequest = {
            authCode: authenticationCode,
            redirectUrl: URL.NEW_IOCARE_REDIRECT_URL,
        };
        const response = await this.executeIoCarePostPayload(IoCareEndpoint.GET_ACCESS_TOKEN, accessTokenRequest)
            .catch(error => error.response);

        return {
            accessToken: response.data.accessToken,
            refreshToken: response.data.refreshToken,
        };
    }

    async executeSetPayloads(deviceInfo: Device, inputs: PayloadCommand[], accessToken?: AccessToken) {
        const functionList: DeviceUpdateCommand[] = inputs.map(({ key, value }) => {
            return {
                funcId: key,
                cmdVal: value
            };
        });
        // Note: if deviceInfo.barcode is undefined, this will crash.
        // You might add a guard here if needed.
        return await this.executeIoCarePostPayload(
            IoCareEndpoint.CONTROL_DEVICE,
            {
                devId: deviceInfo.barcode,
                funcList: functionList,
                dvcTypeCd: deviceInfo.dvcTypeCd,
                isMultiControl: false,
            },
            accessToken,
            true
        ).catch(error => error.response);
    }

    async executeIoCareGetPayload(
        urlKey: IoCareEndpoint | string,
        body: IoCarePayloadRequest,
        accessToken?: AccessToken,
        debug: boolean = false
    ) {
        return await this.executeIoCarePayload(urlKey, 'GET', body, accessToken, debug);
    }

    async executeIoCarePostPayload(
        urlKey: IoCareEndpoint | string,
        body: IoCarePayloadRequest,
        accessToken?: AccessToken,
        debug: boolean = false
    ) {
        return await this.executeIoCarePayload(urlKey, 'POST', body, accessToken, debug);
    }

    private async executeIoCarePayload(
        urlKey: IoCareEndpoint | string,
        httpMethod: 'GET' | 'POST',
        body: IoCarePayloadRequest,
        accessToken?: AccessToken,
        debug: boolean = true
    ) {
        accessToken = accessToken || {
            accessToken: '',
            refreshToken: '',
        };

        // Refresh token if needed
        if (accessToken.accessToken && urlKey !== IoCareEndpoint.REFRESH_TOKEN) {
            const decoded = JSON.parse(Buffer.from(accessToken.accessToken.split(".")[1], 'base64').toString());
            const expire = decoded.exp;
            const now = new Date();
            const isExpired = expire < (now.getTime() / 1000);

            if (isExpired) {
                const response = await this.executeIoCarePostPayload(
                    IoCareEndpoint.REFRESH_TOKEN,
                    { refreshToken: accessToken.refreshToken },
                    accessToken,
                    true
                ).catch(error => error.response);
                accessToken.accessToken = response.data.accessToken;
                accessToken.refreshToken = response.data.refreshToken;
            }
        }

        const [path, transactionCode] = urlKey.split('::');

        let url = URL.NEW_IOCARE_API_URL + path;

        if (httpMethod === 'GET') {
            url += '?' + new URLSearchParams(body as any);
            if (debug) {
                this.log.debug('[GET REQ] %s (%s)', url, transactionCode);
            }
        } else if (debug) {
            this.log.debug('[POST REQ] %s (%s) :: %s', url, transactionCode, JSON.stringify(body));
        }

        const headers: any = {
            'User-Agent': Constants.USER_AGENT,
            'Content-Type': 'application/json',
            'trcode': transactionCode,
            'profile': 'prod',
        };

        if (accessToken.accessToken) {
            headers['Authorization'] = `Bearer ${accessToken.accessToken}`;
        }

        let responsePromise: Promise<AxiosResponse>;
        if (httpMethod === 'GET') {
            responsePromise = this.wrapGet(url, { headers: headers }, !debug);
        } else {
            responsePromise = this.wrapPost(url, body, { headers: headers }, !debug);
        }

        return await responsePromise
            .then((res) => res.data)
            .catch((error) => {
                this.log.debug(error.response.data);
                return error.response.data;
            });
    }

    /**
     * Wrap GET with request/response logging
     */
    private async wrapGet(url: string, config?: AxiosRequestConfig, debug: boolean = true): Promise<AxiosResponse> {
        if (debug) {
            this.log.debug("[GET REQ]", url);
        }
        const res = await axios.get(url, config);

        if (debug) {
            // Log the response data from Coway
            this.log.debug("[GET RESP]", JSON.stringify(res.data));
        }
        return res;
    }

    /**
     * Wrap POST with request/response logging
     */
    private async wrapPost(url: string, data?: any, config?: AxiosRequestConfig, debug: boolean = true): Promise<AxiosResponse> {
        if (debug) {
            this.log.debug("[POST REQ]", url);
        }
        const res = await axios.post(url, data, config);

        if (debug) {
            // Log the response data from Coway
            this.log.debug("[POST RESP]", JSON.stringify(res.data));
        }
        return res;
    }

}
