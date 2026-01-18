<?php
/**
 * Класс для работы с HTTP запросами
 */

namespace App\Core;

class Request
{
    private array $query;
    private array $body;
    private array $files;
    private array $headers;
    private string $method;
    private string $uri;

    public function __construct()
    {
        $this->method = $_SERVER['REQUEST_METHOD'];
        $this->uri = $_SERVER['REQUEST_URI'];
        $this->query = $_GET;
        $this->files = $_FILES;
        $this->headers = $this->parseHeaders();
        $this->body = $this->parseBody();
    }

    private function parseHeaders(): array
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (strpos($key, 'HTTP_') === 0) {
                $header = str_replace('_', '-', substr($key, 5));
                $headers[$header] = $value;
            }
        }
        // В PHP заголовок Content-Type обычно доступен как CONTENT_TYPE (без HTTP_ префикса).
        // Без этого JSON body не будет распарсен, что приводит к ошибкам валидации.
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['CONTENT-TYPE'] = $_SERVER['CONTENT_TYPE'];
        }
        if (isset($_SERVER['CONTENT_LENGTH'])) {
            $headers['CONTENT-LENGTH'] = $_SERVER['CONTENT_LENGTH'];
        }
        return $headers;
    }

    private function parseBody(): array
    {
        $contentType = $this->header('CONTENT-TYPE', '');
        
        if (strpos($contentType, 'application/json') !== false) {
            $raw = file_get_contents('php://input');
            return json_decode($raw, true) ?? [];
        }
        
        if ($this->method === 'POST') {
            return $_POST;
        }

        if (in_array($this->method, ['PUT', 'PATCH', 'DELETE'])) {
            parse_str(file_get_contents('php://input'), $data);
            return $data;
        }

        return [];
    }

    public function method(): string
    {
        return $this->method;
    }

    public function uri(): string
    {
        return $this->uri;
    }

    public function query(string $key = null, $default = null)
    {
        if ($key === null) {
            return $this->query;
        }
        return $this->query[$key] ?? $default;
    }

    public function input(string $key = null, $default = null)
    {
        if ($key === null) {
            return $this->body;
        }
        return $this->body[$key] ?? $default;
    }

    public function all(): array
    {
        return array_merge($this->query, $this->body);
    }

    public function only(array $keys): array
    {
        return array_intersect_key($this->all(), array_flip($keys));
    }

    public function header(string $key, $default = null)
    {
        return $this->headers[strtoupper($key)] ?? $default;
    }

    public function headers(): array
    {
        return $this->headers;
    }

    public function file(string $key)
    {
        return $this->files[$key] ?? null;
    }

    public function files(): array
    {
        return $this->files;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->header('AUTHORIZATION');
        if ($auth && preg_match('/Bearer\s+(.+)$/i', $auth, $matches)) {
            return $matches[1];
        }
        return null;
    }

    public function ip(): string
    {
        return $_SERVER['HTTP_X_FORWARDED_FOR'] 
            ?? $_SERVER['HTTP_X_REAL_IP'] 
            ?? $_SERVER['REMOTE_ADDR'] 
            ?? '0.0.0.0';
    }

    public function userAgent(): string
    {
        return $_SERVER['HTTP_USER_AGENT'] ?? '';
    }

    public function isAjax(): bool
    {
        return $this->header('X-REQUESTED-WITH') === 'XMLHttpRequest';
    }

    public function validate(array $rules): array
    {
        $errors = [];
        $data = $this->all();

        foreach ($rules as $field => $rule) {
            $ruleList = is_array($rule) ? $rule : explode('|', $rule);
            
            foreach ($ruleList as $r) {
                $params = [];
                if (strpos($r, ':') !== false) {
                    [$r, $paramStr] = explode(':', $r);
                    $params = explode(',', $paramStr);
                }

                $value = $data[$field] ?? null;
                $error = $this->validateRule($field, $value, $r, $params);
                
                if ($error) {
                    $errors[$field][] = $error;
                }
            }
        }

        return $errors;
    }

    private function validateRule(string $field, $value, string $rule, array $params): ?string
    {
        switch ($rule) {
            case 'required':
                if (empty($value) && $value !== '0' && $value !== 0) {
                    return "Поле {$field} обязательно для заполнения";
                }
                break;

            case 'string':
                if ($value !== null && !is_string($value)) {
                    return "Поле {$field} должно быть строкой";
                }
                break;

            case 'integer':
                if ($value !== null && !filter_var($value, FILTER_VALIDATE_INT)) {
                    return "Поле {$field} должно быть целым числом";
                }
                break;

            case 'numeric':
                if ($value !== null && !is_numeric($value)) {
                    return "Поле {$field} должно быть числом";
                }
                break;

            case 'email':
                if ($value !== null && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
                    return "Поле {$field} должно быть email адресом";
                }
                break;

            case 'min':
                $min = (int) ($params[0] ?? 0);
                if (is_string($value) && strlen($value) < $min) {
                    return "Поле {$field} должно содержать минимум {$min} символов";
                }
                if (is_numeric($value) && $value < $min) {
                    return "Поле {$field} должно быть не менее {$min}";
                }
                break;

            case 'max':
                $max = (int) ($params[0] ?? 0);
                if (is_string($value) && strlen($value) > $max) {
                    return "Поле {$field} должно содержать максимум {$max} символов";
                }
                if (is_numeric($value) && $value > $max) {
                    return "Поле {$field} должно быть не более {$max}";
                }
                break;

            case 'in':
                if ($value !== null && !in_array($value, $params)) {
                    return "Поле {$field} должно быть одним из: " . implode(', ', $params);
                }
                break;
        }

        return null;
    }
}
